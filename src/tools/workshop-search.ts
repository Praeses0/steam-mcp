import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { formatBytes } from '../util/format.js';

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
// Registration
// ---------------------------------------------------------------------------

export function registerWorkshopSearchTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // workshop_search
  // -------------------------------------------------------------------------
  server.tool(
    'workshop_search',
    'Search Steam Workshop items by keyword for a game',
    {
      appid: z.number().describe('Steam application ID'),
      query: z.string().describe('Search query string'),
      count: z.number().default(10).describe('Number of results to return (default 10, max 100)'),
    },
    async (params) => {
      try {
        const { appid, query } = params;
        const count = Math.min(Math.max(params.count, 1), 100);

        const data = await steamApiRequest<QueryFilesResponse>(
          'IPublishedFileService',
          'QueryFiles',
          'v1',
          {
            query_type: 3,
            page: 1,
            numperpage: count,
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error searching workshop: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
