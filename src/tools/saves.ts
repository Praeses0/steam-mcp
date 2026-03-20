import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getUserDataDir } from '../steam/paths.js';
import { readAllManifests } from '../steam/manifests.js';
import { formatBytes } from '../util/format.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SaveInfo {
  appid: number;
  name: string;
  path: string;
  size: number;
  fileCount: number;
}

function walkDirStats(dirPath: string): { size: number; fileCount: number } {
  let size = 0;
  let fileCount = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          const sub = walkDirStats(fullPath);
          size += sub.size;
          fileCount += sub.fileCount;
        } else if (entry.isFile()) {
          size += fs.statSync(fullPath).size;
          fileCount++;
        }
      } catch {
        // skip inaccessible entries
      }
    }
  } catch {
    // directory unreadable
  }

  return { size, fileCount };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSaveTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // list_cloud_saves
  // -------------------------------------------------------------------------
  server.tool(
    'list_cloud_saves',
    'List local cloud save data per game',
    {
      sort_by: z
        .enum(['size', 'name'])
        .default('size')
        .describe('Sort field'),
      limit: z.number().default(50).describe('Max results to return'),
    },
    async (params) => {
      try {
        const userdataPath = getUserDataDir();
        const manifests = await readAllManifests();
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        const saves: SaveInfo[] = [];

        // Walk userdata/{userId}/ looking for per-app directories
        try {
          const appDirs = fs.readdirSync(userdataPath, { withFileTypes: true });
          for (const entry of appDirs) {
            if (!entry.isDirectory()) continue;
            const appid = parseInt(entry.name, 10);
            if (isNaN(appid)) continue;

            const appPath = path.join(userdataPath, entry.name);
            const stats = walkDirStats(appPath);

            if (stats.fileCount > 0) {
              saves.push({
                appid,
                name: nameMap.get(appid) ?? `Unknown (${appid})`,
                path: appPath,
                size: stats.size,
                fileCount: stats.fileCount,
              });
            }
          }
        } catch {
          // userdata path unreadable
        }

        // Sort
        if (params.sort_by === 'name') {
          saves.sort((a, b) => a.name.localeCompare(b.name));
        } else {
          saves.sort((a, b) => b.size - a.size);
        }

        const limited = saves.slice(0, params.limit);
        const totalSize = saves.reduce((sum, s) => sum + s.size, 0);

        const output = {
          totalGames: saves.length,
          totalSize: formatBytes(totalSize),
          returned: limited.length,
          saves: limited.map((s) => ({
            appid: s.appid,
            name: s.name,
            size: formatBytes(s.size),
            fileCount: s.fileCount,
          })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error listing cloud saves: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // cloud_save_stats
  // -------------------------------------------------------------------------
  server.tool(
    'cloud_save_stats',
    'Get cloud save stats with total size and top games',
    {},
    async () => {
      try {
        const userdataPath = getUserDataDir();
        const manifests = await readAllManifests();
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        const saves: SaveInfo[] = [];

        try {
          const appDirs = fs.readdirSync(userdataPath, { withFileTypes: true });
          for (const entry of appDirs) {
            if (!entry.isDirectory()) continue;
            const appid = parseInt(entry.name, 10);
            if (isNaN(appid)) continue;

            const appPath = path.join(userdataPath, entry.name);
            const stats = walkDirStats(appPath);

            if (stats.fileCount > 0) {
              saves.push({
                appid,
                name: nameMap.get(appid) ?? `Unknown (${appid})`,
                path: appPath,
                size: stats.size,
                fileCount: stats.fileCount,
              });
            }
          }
        } catch {
          // userdata path unreadable
        }

        saves.sort((a, b) => b.size - a.size);

        const totalSize = saves.reduce((sum, s) => sum + s.size, 0);
        const totalFiles = saves.reduce((sum, s) => sum + s.fileCount, 0);

        const output = {
          totalGames: saves.length,
          totalSize: formatBytes(totalSize),
          totalFiles,
          top10BySize: saves.slice(0, 10).map((s) => ({
            appid: s.appid,
            name: s.name,
            size: formatBytes(s.size),
            fileCount: s.fileCount,
          })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error getting cloud save stats: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
