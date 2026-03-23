import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { readAllManifests } from '../steam/manifests.js';
import { getLibraries } from '../steam/library.js';
import { getAllProtonVersionMappings, getInstalledProtonVersions } from '../steam/compat.js';
import { getSteamDir, getUserDataDir } from '../steam/paths.js';
import { formatBytes } from '../util/format.js';
import { getDirSize } from '../util/fs.js';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * List appid subdirectories in a given directory.
 * Returns array of { appid, path, size }.
 */
function listAppidDirs(
  dirPath: string,
): Array<{ appid: number; dirPath: string; size: number }> {
  const results: Array<{ appid: number; dirPath: string; size: number }> = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = parseInt(entry.name, 10);
      if (isNaN(id)) continue;
      const fullPath = path.join(dirPath, entry.name);
      results.push({ appid: id, dirPath: fullPath, size: getDirSize(fullPath) });
    }
  } catch {
    // directory may not exist
  }
  return results;
}

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

export function registerStorageTools(server: McpServer): void {
  server.tool(
    'storage',
    'Disk usage, cleanup, shader cache, cloud saves, backups',
    {
      action: z.enum([
        'disk_report',
        'orphaned',
        'cleanup',
        'shader_cache',
        'shader_stats',
        'saves_list',
        'saves_stats',
        'backup',
      ]),
      appid: z.number().optional(),
      destination: z.string().optional().describe('Backup destination directory'),
      sort_by: z.enum(['name', 'size']).optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      switch (params.action) {
        // -------------------------------------------------------------------
        // disk_report
        // -------------------------------------------------------------------
        case 'disk_report': {
          try {
            const manifests = await readAllManifests();
            const libraries = getLibraries();

            const nameMap = new Map<number, string>();
            for (const m of manifests) {
              nameMap.set(m.appid, m.name);
            }

            let totalInstallSize = 0;
            let totalCompatdataSize = 0;
            let totalShadercacheSize = 0;
            let totalWorkshopSize = 0;

            const gameBreakdown = new Map<
              number,
              {
                name: string;
                install: number;
                compatdata: number;
                shadercache: number;
                workshop: number;
                total: number;
              }
            >();

            const ensureGame = (appid: number) => {
              if (!gameBreakdown.has(appid)) {
                gameBreakdown.set(appid, {
                  name: nameMap.get(appid) ?? `Unknown (${appid})`,
                  install: 0,
                  compatdata: 0,
                  shadercache: 0,
                  workshop: 0,
                  total: 0,
                });
              }
              return gameBreakdown.get(appid)!;
            };

            for (const m of manifests) {
              const entry = ensureGame(m.appid);
              entry.install = m.sizeOnDisk;
              totalInstallSize += m.sizeOnDisk;
            }

            for (const lib of libraries) {
              if (!lib.mounted) continue;
              const steamappsDir = path.join(lib.path, 'steamapps');

              const compatdataDirs = listAppidDirs(
                path.join(steamappsDir, 'compatdata'),
              );
              for (const cd of compatdataDirs) {
                const entry = ensureGame(cd.appid);
                entry.compatdata += cd.size;
                totalCompatdataSize += cd.size;
              }

              const shadercacheDirs = listAppidDirs(
                path.join(steamappsDir, 'shadercache'),
              );
              for (const sc of shadercacheDirs) {
                const entry = ensureGame(sc.appid);
                entry.shadercache += sc.size;
                totalShadercacheSize += sc.size;
              }

              const workshopContentDir = path.join(steamappsDir, 'workshop', 'content');
              const workshopDirs = listAppidDirs(workshopContentDir);
              for (const ws of workshopDirs) {
                const entry = ensureGame(ws.appid);
                entry.workshop += ws.size;
                totalWorkshopSize += ws.size;
              }
            }

            for (const entry of gameBreakdown.values()) {
              entry.total =
                entry.install + entry.compatdata + entry.shadercache + entry.workshop;
            }

            const totalFootprint =
              totalInstallSize +
              totalCompatdataSize +
              totalShadercacheSize +
              totalWorkshopSize;

            const sortedGames = [...gameBreakdown.entries()]
              .sort((a, b) => b[1].total - a[1].total)
              .map(([appid, data]) => ({
                appid,
                name: data.name,
                install: formatBytes(data.install),
                compatdata: formatBytes(data.compatdata),
                shadercache: formatBytes(data.shadercache),
                workshop: formatBytes(data.workshop),
                total: formatBytes(data.total),
              }));

            const output = {
              totalFootprint: formatBytes(totalFootprint),
              breakdown: {
                installs: formatBytes(totalInstallSize),
                compatdata: formatBytes(totalCompatdataSize),
                shadercache: formatBytes(totalShadercacheSize),
                workshop: formatBytes(totalWorkshopSize),
              },
              gameCount: sortedGames.length,
              perGameBreakdown: sortedGames,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error generating disk usage report: ${msg}` },
              ],
              isError: true,
            };
          }
        }

        // -------------------------------------------------------------------
        // orphaned
        // -------------------------------------------------------------------
        case 'orphaned': {
          try {
            const manifests = await readAllManifests();
            const libraries = getLibraries();
            const installedAppids = new Set(manifests.map((m) => m.appid));

            const orphaned: Array<{
              appid: number;
              category: string;
              path: string;
              size: string;
              sizeBytes: number;
            }> = [];

            for (const lib of libraries) {
              if (!lib.mounted) continue;
              const steamappsDir = path.join(lib.path, 'steamapps');

              const categories = ['compatdata', 'shadercache'] as const;
              for (const category of categories) {
                const dirs = listAppidDirs(path.join(steamappsDir, category));
                for (const dir of dirs) {
                  if (!installedAppids.has(dir.appid)) {
                    orphaned.push({
                      appid: dir.appid,
                      category,
                      path: dir.dirPath,
                      size: formatBytes(dir.size),
                      sizeBytes: dir.size,
                    });
                  }
                }
              }

              const workshopContentDir = path.join(
                steamappsDir,
                'workshop',
                'content',
              );
              const workshopDirs = listAppidDirs(workshopContentDir);
              for (const ws of workshopDirs) {
                if (!installedAppids.has(ws.appid)) {
                  orphaned.push({
                    appid: ws.appid,
                    category: 'workshop',
                    path: ws.dirPath,
                    size: formatBytes(ws.size),
                    sizeBytes: ws.size,
                  });
                }
              }
            }

            orphaned.sort((a, b) => b.sizeBytes - a.sizeBytes);

            const totalSize = orphaned.reduce((sum, o) => sum + o.sizeBytes, 0);

            const output = {
              orphanedCount: orphaned.length,
              totalSize: formatBytes(totalSize),
              orphaned: orphaned.map(({ sizeBytes: _, ...rest }) => rest),
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error finding orphaned data: ${msg}` },
              ],
              isError: true,
            };
          }
        }

        // -------------------------------------------------------------------
        // cleanup
        // -------------------------------------------------------------------
        case 'cleanup': {
          try {
            const manifests = await readAllManifests();
            const libraries = getLibraries();
            const installedAppids = new Set(manifests.map((m) => m.appid));
            const nameMap = new Map<number, string>();
            for (const m of manifests) {
              nameMap.set(m.appid, m.name);
            }

            // 1. Orphaned data (safe to delete)
            const orphaned: Array<{
              appid: number;
              category: string;
              path: string;
              size: string;
              sizeBytes: number;
            }> = [];

            for (const lib of libraries) {
              if (!lib.mounted) continue;
              const steamappsDir = path.join(lib.path, 'steamapps');

              for (const category of ['compatdata', 'shadercache'] as const) {
                const dirs = listAppidDirs(path.join(steamappsDir, category));
                for (const dir of dirs) {
                  if (!installedAppids.has(dir.appid)) {
                    orphaned.push({
                      appid: dir.appid,
                      category,
                      path: dir.dirPath,
                      size: formatBytes(dir.size),
                      sizeBytes: dir.size,
                    });
                  }
                }
              }
            }
            orphaned.sort((a, b) => b.sizeBytes - a.sizeBytes);

            // 2. Largest shader caches (can be rebuilt)
            const shaderCaches: Array<{
              appid: number;
              name: string;
              path: string;
              size: string;
              sizeBytes: number;
            }> = [];

            for (const lib of libraries) {
              if (!lib.mounted) continue;
              const scDir = path.join(lib.path, 'steamapps', 'shadercache');
              const dirs = listAppidDirs(scDir);
              for (const dir of dirs) {
                if (installedAppids.has(dir.appid)) {
                  shaderCaches.push({
                    appid: dir.appid,
                    name: nameMap.get(dir.appid) ?? `Unknown (${dir.appid})`,
                    path: dir.dirPath,
                    size: formatBytes(dir.size),
                    sizeBytes: dir.size,
                  });
                }
              }
            }
            shaderCaches.sort((a, b) => b.sizeBytes - a.sizeBytes);

            // 3. Games installed but never played
            const neverPlayed = manifests
              .filter((m) => m.lastPlayed === 0)
              .sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)
              .map((m) => ({
                appid: m.appid,
                name: m.name,
                size: formatBytes(m.sizeOnDisk),
              }));

            // 4. Proton versions not used by any game
            const protonMappings = getAllProtonVersionMappings();
            const usedProtonVersions = new Set<string>();
            for (const m of manifests) {
              const version = protonMappings[m.appid];
              if (version) {
                usedProtonVersions.add(version);
              }
            }

            const installedVersions = getInstalledProtonVersions();
            const unusedProton: Array<{ name: string; path: string; size: string }> =
              [];

            for (const v of installedVersions) {
              if (!usedProtonVersions.has(v.name)) {
                unusedProton.push({
                  name: v.name,
                  path: v.path,
                  size: formatBytes(v.size),
                });
              }
            }

            const output = {
              orphanedData: {
                description:
                  'Data directories for uninstalled games. Safe to delete.',
                count: orphaned.length,
                totalSize: formatBytes(
                  orphaned.reduce((s, o) => s + o.sizeBytes, 0),
                ),
                items: orphaned
                  .slice(0, 20)
                  .map(({ sizeBytes: _, ...rest }) => rest),
              },
              largestShaderCaches: {
                description:
                  'Shader caches for installed games. Can be deleted; Steam will rebuild them on next launch.',
                top10: shaderCaches
                  .slice(0, 10)
                  .map(({ sizeBytes: _, ...rest }) => rest),
              },
              neverPlayedGames: {
                description:
                  'Installed games that have never been played. Consider uninstalling to reclaim space.',
                count: neverPlayed.length,
                games: neverPlayed,
              },
              unusedProtonVersions: {
                description:
                  'Proton versions not used by any installed game. Consider removing.',
                versions: unusedProton,
              },
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error generating cleanup recommendations: ${msg}`,
                },
              ],
              isError: true,
            };
          }
        }

        // -------------------------------------------------------------------
        // shader_cache
        // -------------------------------------------------------------------
        case 'shader_cache': {
          try {
            const libraries = getLibraries();

            if (params.appid === undefined) {
              return {
                content: [
                  { type: 'text' as const, text: 'appid is required for shader_cache action.' },
                ],
                isError: true,
              };
            }

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
        }

        // -------------------------------------------------------------------
        // shader_stats
        // -------------------------------------------------------------------
        case 'shader_stats': {
          try {
            const libraries = getLibraries();
            const manifests = await readAllManifests();
            const nameMap = new Map<number, string>();
            for (const m of manifests) {
              nameMap.set(m.appid, m.name);
            }

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
        }

        // -------------------------------------------------------------------
        // saves_list
        // -------------------------------------------------------------------
        case 'saves_list': {
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

            const sortBy = params.sort_by ?? 'size';
            if (sortBy === 'name') {
              saves.sort((a, b) => a.name.localeCompare(b.name));
            } else {
              saves.sort((a, b) => b.size - a.size);
            }

            const limitVal = params.limit ?? 50;
            const limited = saves.slice(0, limitVal);
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
        }

        // -------------------------------------------------------------------
        // saves_stats
        // -------------------------------------------------------------------
        case 'saves_stats': {
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
        }

        // -------------------------------------------------------------------
        // backup
        // -------------------------------------------------------------------
        case 'backup': {
          try {
            if (!params.destination) {
              return {
                content: [
                  { type: 'text' as const, text: 'destination is required for backup action.' },
                ],
                isError: true,
              };
            }

            const userDataDir = getUserDataDir();
            const destination = params.destination;

            fs.mkdirSync(destination, { recursive: true });

            const manifests = await readAllManifests();
            const nameMap = new Map<number, string>();
            for (const m of manifests) {
              nameMap.set(m.appid, m.name);
            }

            let gamesBackedUp = 0;
            let totalSize = 0;

            if (params.appid !== undefined) {
              const src = path.join(userDataDir, String(params.appid));
              if (!fs.existsSync(src)) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `No cloud save data found for appid ${params.appid} in ${userDataDir}`,
                    },
                  ],
                  isError: true,
                };
              }
              const dest = path.join(destination, String(params.appid));
              fs.cpSync(src, dest, { recursive: true });
              const size = getDirSize(dest);
              totalSize += size;
              gamesBackedUp = 1;
            } else {
              try {
                const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (!entry.isDirectory()) continue;
                  const id = parseInt(entry.name, 10);
                  if (isNaN(id)) continue;

                  const src = path.join(userDataDir, entry.name);
                  const dest = path.join(destination, entry.name);
                  fs.cpSync(src, dest, { recursive: true });
                  const size = getDirSize(dest);
                  totalSize += size;
                  gamesBackedUp++;
                }
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Error reading userdata directory ${userDataDir}: ${errMsg}`,
                    },
                  ],
                  isError: true,
                };
              }
            }

            const output = {
              gamesBackedUp,
              totalSize: formatBytes(totalSize),
              destination,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error backing up saves: ${msg}` },
              ],
              isError: true,
            };
          }
        }
      }
    },
  );
}
