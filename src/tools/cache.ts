import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { readAllManifests } from '../steam/manifests.js';
import { getLibraries } from '../steam/library.js';
import { getSteamDir } from '../steam/paths.js';
import { formatBytes } from '../util/format.js';
import { getDirSize } from '../util/fs.js';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCacheTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_shader_cache
  // -------------------------------------------------------------------------
  server.tool(
    'get_shader_cache',
    'Get shader cache size and path for a game',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const libraries = getLibraries();

        let cacheFound = false;
        let totalSize = 0;
        const paths: string[] = [];

        for (const lib of libraries) {
          if (!lib.mounted) continue;
          const cacheDir = path.join(
            lib.path,
            'steamapps',
            'shadercache',
            String(params.appid),
          );
          try {
            const stat = fs.statSync(cacheDir);
            if (stat.isDirectory()) {
              const size = getDirSize(cacheDir);
              totalSize += size;
              paths.push(cacheDir);
              cacheFound = true;
            }
          } catch {
            // not found in this library
          }
        }

        if (!cacheFound) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No shader cache found for appid ${params.appid}.`,
              },
            ],
          };
        }

        const output = {
          appid: params.appid,
          size: formatBytes(totalSize),
          sizeBytes: totalSize,
          paths,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error getting shader cache: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // shader_cache_stats
  // -------------------------------------------------------------------------
  server.tool(
    'shader_cache_stats',
    'Get shader cache overview with top games and GPU info',
    {},
    async () => {
      try {
        const libraries = getLibraries();
        const manifests = await readAllManifests();
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        // Aggregate shader cache sizes across all libraries
        const cacheMap = new Map<number, { size: number; paths: string[] }>();

        for (const lib of libraries) {
          if (!lib.mounted) continue;
          const scDir = path.join(lib.path, 'steamapps', 'shadercache');
          try {
            const entries = fs.readdirSync(scDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const appid = parseInt(entry.name, 10);
              if (isNaN(appid)) continue;
              const fullPath = path.join(scDir, entry.name);
              const size = getDirSize(fullPath);

              if (!cacheMap.has(appid)) {
                cacheMap.set(appid, { size: 0, paths: [] });
              }
              const existing = cacheMap.get(appid)!;
              existing.size += size;
              existing.paths.push(fullPath);
            }
          } catch {
            // skip
          }
        }

        // Build sorted list
        const cacheList = [...cacheMap.entries()]
          .map(([appid, data]) => ({
            appid,
            name: nameMap.get(appid) ?? `Unknown (${appid})`,
            size: formatBytes(data.size),
            sizeBytes: data.size,
          }))
          .sort((a, b) => b.sizeBytes - a.sizeBytes);

        const totalSize = cacheList.reduce((sum, c) => sum + c.sizeBytes, 0);

        // Try to read GPU/driver info from config.vdf ShaderCacheManager
        let gpuInfo: Record<string, unknown> | null = null;
        try {
          const steamPath = getSteamDir();
          const configPath = path.join(steamPath, 'config', 'config.vdf');
          const configText = fs.readFileSync(configPath, 'utf-8');
          const configVdf = parseVdf(configText);

          // Navigate to ShaderCacheManager
          const installs = configVdf.InstallConfigStore as VdfObject | undefined;
          const software = installs?.Software as VdfObject | undefined;
          const valve = software?.Valve as VdfObject | undefined ??
            software?.valve as VdfObject | undefined;
          const steam = valve?.Steam as VdfObject | undefined ??
            valve?.steam as VdfObject | undefined;
          const shaderCache = steam?.ShaderCacheManager as VdfObject | undefined;

          if (shaderCache && typeof shaderCache === 'object') {
            gpuInfo = {};
            for (const [key, value] of Object.entries(shaderCache)) {
              if (typeof value === 'string') {
                gpuInfo[key] = value;
              }
            }
          }
        } catch {
          // config.vdf may not exist or not have ShaderCacheManager
        }

        const output: Record<string, unknown> = {
          totalSize: formatBytes(totalSize),
          cacheCount: cacheList.length,
          top10BySize: cacheList
            .slice(0, 10)
            .map(({ sizeBytes: _, ...rest }) => rest),
        };

        if (gpuInfo && Object.keys(gpuInfo).length > 0) {
          output.gpuDriverInfo = gpuInfo;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error getting shader cache stats: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
