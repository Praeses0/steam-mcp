import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readWorkshopManifest, readAllWorkshopData } from '../steam/workshop.js';
import { getLibraryFolders } from '../steam/paths.js';
import { readAllManifests } from '../steam/manifests.js';
import { steamApiRequest } from '../steam/api.js';
import { formatBytes, formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishedFileTag {
  tag: string;
}

interface PublishedFileDetail {
  publishedfileid: string;
  title: string;
  file_description: string;
  short_description: string;
  time_created: number;
  time_updated: number;
  subscriptions: number;
  favorited: number;
  views: number;
  file_size: number;
  preview_url: string;
  tags: PublishedFileTag[];
}

interface QueryFilesResponse {
  response: {
    total: number;
    publishedfiledetails: PublishedFileDetail[];
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleList(appid: number) {
  const folders = getLibraryFolders();
  let workshop: { appid: number; sizeOnDisk: number; items: import('../steam/types.js').WorkshopItem[] } | null = null;
  for (const folder of folders) {
    const wsPath = `${folder}/steamapps/workshop/appworkshop_${appid}.acf`;
    try {
      workshop = readWorkshopManifest(wsPath);
      break;
    } catch {
      // not in this library
    }
  }

  if (!workshop || workshop.items.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No Workshop items found for appid ${appid}.`,
        },
      ],
    };
  }

  const items = workshop.items.map((item) => ({
    publishedFileId: item.publishedFileId,
    size: formatBytes(item.size),
    lastUpdated: formatTimestamp(item.timeUpdated),
  }));

  const output = {
    appid,
    totalItems: items.length,
    totalSize: formatBytes(workshop.sizeOnDisk),
    items,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

async function handleStats() {
  const allWorkshop = readAllWorkshopData();
  const manifests = readAllManifests();
  const nameMap = new Map<number, string>();
  for (const m of manifests) {
    nameMap.set(m.appid, m.name);
  }

  let totalItems = 0;
  let totalSize = 0;

  const perGame: Array<{
    appid: number;
    name: string;
    itemCount: number;
    totalSize: string;
    totalSizeBytes: number;
  }> = [];

  for (const [appid, ws] of allWorkshop) {
    totalItems += ws.items.length;
    totalSize += ws.sizeOnDisk;

    perGame.push({
      appid,
      name: nameMap.get(appid) ?? `Unknown (${appid})`,
      itemCount: ws.items.length,
      totalSize: formatBytes(ws.sizeOnDisk),
      totalSizeBytes: ws.sizeOnDisk,
    });
  }

  // Sort by size descending
  perGame.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);

  const output = {
    totalItems,
    totalSize: formatBytes(totalSize),
    gameCount: perGame.length,
    perGameBreakdown: perGame.map(({ totalSizeBytes: _, ...rest }) => rest),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

async function handleSearch(appid: number, query: string, count: number) {
  const numResults = Math.min(Math.max(count, 1), 100);

  const data = await steamApiRequest<QueryFilesResponse>(
    'IPublishedFileService',
    'QueryFiles',
    'v1',
    {
      query_type: 3,
      page: 1,
      numperpage: numResults,
      appid,
      search_text: query,
      return_short_description: 1,
      return_metadata: 1,
    },
  );

  const response = data.response;
  const items = response.publishedfiledetails ?? [];

  const results = items.map((item) => {
    const description = item.short_description || item.file_description || '';
    return {
      id: item.publishedfileid,
      title: item.title,
      description: description.length > 200
        ? description.slice(0, 200) + '...'
        : description,
      subscriptions: item.subscriptions,
      favorites: item.favorited,
      views: item.views,
      size: formatBytes(item.file_size),
      tags: (item.tags ?? []).map((t) => t.tag),
      preview_url: item.preview_url || null,
      workshop_url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`,
    };
  });

  const output = {
    appid,
    query,
    total_results: response.total,
    showing: results.length,
    items: results,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkshopTools(server: McpServer): void {
  server.tool(
    'workshop',
    'List workshop items, stats, or search',
    {
      action: z.enum(['list', 'stats', 'search']),
      appid: z.number().optional(),
      query: z.string().optional(),
      count: z.number().optional(),
    },
    async (params) => {
      try {
        switch (params.action) {
          case 'list': {
            if (params.appid == null) {
              return {
                content: [{ type: 'text' as const, text: 'appid is required for action "list"' }],
                isError: true,
              };
            }
            return await handleList(params.appid);
          }
          case 'stats': {
            return await handleStats();
          }
          case 'search': {
            if (params.appid == null) {
              return {
                content: [{ type: 'text' as const, text: 'appid is required for action "search"' }],
                isError: true,
              };
            }
            if (!params.query) {
              return {
                content: [{ type: 'text' as const, text: 'query is required for action "search"' }],
                isError: true,
              };
            }
            return await handleSearch(params.appid, params.query, params.count ?? 10);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error in workshop (${params.action}): ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
