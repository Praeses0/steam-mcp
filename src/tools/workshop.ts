import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readWorkshopManifest, readAllWorkshopData } from '../steam/workshop.js';
import { getLibraryFolders } from '../steam/paths.js';
import { readAllManifests } from '../steam/manifests.js';
import { formatBytes, formatTimestamp } from '../util/format.js';

export function registerWorkshopTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // list_workshop_items
  // -------------------------------------------------------------------------
  server.tool(
    'list_workshop_items',
    'List installed Steam Workshop items for a specific game',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        // Search all library folders for the workshop manifest
        const folders = getLibraryFolders();
        let workshop: { appid: number; sizeOnDisk: number; items: import('../steam/types.js').WorkshopItem[] } | null = null;
        for (const folder of folders) {
          const wsPath = `${folder}/steamapps/workshop/appworkshop_${params.appid}.acf`;
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
                text: `No Workshop items found for appid ${params.appid}.`,
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
          appid: params.appid,
          totalItems: items.length,
          totalSize: formatBytes(workshop.sizeOnDisk),
          items,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error listing workshop items: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_workshop_stats
  // -------------------------------------------------------------------------
  server.tool(
    'get_workshop_stats',
    'Get aggregate Steam Workshop statistics: total items, total size, and per-game breakdown',
    {},
    async () => {
      try {
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error getting workshop stats: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
