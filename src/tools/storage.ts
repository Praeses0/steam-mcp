import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readAllManifests } from '../steam/manifests.js';
import { getLibraries } from '../steam/library.js';
import { getAllProtonVersionMappings, getInstalledProtonVersions } from '../steam/compat.js';
import { readWorkshopManifest } from '../steam/workshop.js';
import { getSteamDir, getUserDataDir, getUserConfig, isSteamRunning } from '../steam/paths.js';
import { formatBytes } from '../util/format.js';
import { getDirSize } from '../util/fs.js';

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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStorageTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // disk_usage_report
  // -------------------------------------------------------------------------
  server.tool(
    'disk_usage_report',
    'Comprehensive per-game disk usage breakdown including installs, compatdata (Proton prefixes), shader caches, workshop content, and cloud saves',
    {},
    async () => {
      try {
        const steamPath = getSteamDir();
        const manifests = await readAllManifests();
        const libraries = getLibraries();

        // Build a map of appid -> name
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        // Collect per-category totals
        let totalInstallSize = 0;
        let totalCompatdataSize = 0;
        let totalShadercacheSize = 0;
        let totalWorkshopSize = 0;

        // Per-game breakdown
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

        // Install sizes from manifests
        for (const m of manifests) {
          const entry = ensureGame(m.appid);
          entry.install = m.sizeOnDisk;
          totalInstallSize += m.sizeOnDisk;
        }

        // Scan compatdata, shadercache, workshop across all libraries
        for (const lib of libraries) {
          if (!lib.mounted) continue;
          const steamappsDir = path.join(lib.path, 'steamapps');

          // compatdata
          const compatdataDirs = listAppidDirs(
            path.join(steamappsDir, 'compatdata'),
          );
          for (const cd of compatdataDirs) {
            const entry = ensureGame(cd.appid);
            entry.compatdata += cd.size;
            totalCompatdataSize += cd.size;
          }

          // shadercache
          const shadercacheDirs = listAppidDirs(
            path.join(steamappsDir, 'shadercache'),
          );
          for (const sc of shadercacheDirs) {
            const entry = ensureGame(sc.appid);
            entry.shadercache += sc.size;
            totalShadercacheSize += sc.size;
          }

          // workshop content
          const workshopContentDir = path.join(steamappsDir, 'workshop', 'content');
          const workshopDirs = listAppidDirs(workshopContentDir);
          for (const ws of workshopDirs) {
            const entry = ensureGame(ws.appid);
            entry.workshop += ws.size;
            totalWorkshopSize += ws.size;
          }
        }

        // Calculate totals per game
        for (const entry of gameBreakdown.values()) {
          entry.total =
            entry.install + entry.compatdata + entry.shadercache + entry.workshop;
        }

        const totalFootprint =
          totalInstallSize +
          totalCompatdataSize +
          totalShadercacheSize +
          totalWorkshopSize;

        // Sort by total size descending
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
    },
  );

  // -------------------------------------------------------------------------
  // find_orphaned_data
  // -------------------------------------------------------------------------
  server.tool(
    'find_orphaned_data',
    'Find orphaned data directories (compatdata, shadercache, workshop) for games that are no longer installed',
    {},
    async () => {
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

          // Workshop content
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

        // Sort by size descending
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
    },
  );

  // -------------------------------------------------------------------------
  // cleanup_recommendations
  // -------------------------------------------------------------------------
  server.tool(
    'cleanup_recommendations',
    'Get actionable cleanup suggestions: orphaned data, large shader caches, never-played games, and unused Proton versions',
    {},
    async () => {
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

        // 4. Proton versions not used by any game — parse config.vdf once
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
    },
  );

  // -------------------------------------------------------------------------
  // move_game
  // -------------------------------------------------------------------------
  server.tool(
    'move_game',
    'Trigger Steam\'s move-game-to-library dialog for an installed game. Steam must be running.',
    {
      appid: z.number().describe('Steam application ID to move'),
    },
    async (params) => {
      try {
        // Check Steam is running
        if (!isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Steam is not running. Please start Steam first.',
              },
            ],
            isError: true,
          };
        }

        // Verify game is installed
        let gameName = `appid ${params.appid}`;
        const manifests = await readAllManifests();
        const manifest = manifests.find((m) => m.appid === params.appid);
        if (!manifest) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Game with appid ${params.appid} is not installed. Cannot move.`,
              },
            ],
            isError: true,
          };
        }
        gameName = manifest.name;

        const url = `steam://move/${params.appid}`;
        const child = spawn('steam', [url], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Move requested for "${gameName}" (appid: ${params.appid})`,
                `Protocol URL: ${url}`,
                '',
                'Steam will show the move dialog. Select the target library folder in the Steam client.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error requesting game move: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // backup_saves
  // -------------------------------------------------------------------------
  server.tool(
    'backup_saves',
    'Copy cloud save data from Steam userdata to a backup directory. Can back up a single game or all games.',
    {
      appid: z.number().optional().describe('Steam application ID to back up saves for. If omitted, backs up all games.'),
      destination: z.string().describe('Backup directory path where saves will be copied to'),
    },
    async (params) => {
      try {
        const userDataDir = getUserDataDir();
        const destination = params.destination;

        // Ensure destination exists
        fs.mkdirSync(destination, { recursive: true });

        const manifests = await readAllManifests();
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        let gamesBackedUp = 0;
        let totalSize = 0;

        if (params.appid !== undefined) {
          // Backup a single game
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
          // Backup all games
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
    },
  );

  // -------------------------------------------------------------------------
  // estimate_install_size
  // -------------------------------------------------------------------------
  server.tool(
    'estimate_install_size',
    'Query the Steam store API for game info and system requirements before installing.',
    {
      appid: z.number().describe('Steam application ID to look up'),
    },
    async (params) => {
      try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${params.appid}`;
        const response = await fetch(url);
        if (!response.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Steam store API returned HTTP ${response.status}`,
              },
            ],
            isError: true,
          };
        }

        const json = (await response.json()) as Record<
          string,
          { success: boolean; data?: Record<string, unknown> }
        >;
        const entry = json[String(params.appid)];

        if (!entry || !entry.success || !entry.data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No data found for appid ${params.appid}. The game may not exist or may be region-locked.`,
              },
            ],
            isError: true,
          };
        }

        const data = entry.data;

        const output = {
          appid: params.appid,
          name: data['name'] ?? 'Unknown',
          type: data['type'] ?? 'Unknown',
          isFree: data['is_free'] ?? false,
          shortDescription: data['short_description'] ?? '',
          pcRequirements: data['pc_requirements'] ?? null,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error fetching install size info: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
