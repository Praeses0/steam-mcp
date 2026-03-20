import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { readAllManifests } from '../steam/manifests.js';
import { getGameProtonVersion, getCompatDataSize, getCompatOverrides, getInstalledProtonVersions, getAllProtonVersionMappings } from '../steam/compat.js';
import { getLibraries } from '../steam/library.js';
import { getSteamDir, getLibraryFolders } from '../steam/paths.js';
import { formatBytes } from '../util/format.js';
import { getDirSize, countFiles } from '../util/fs.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCompatTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // list_proton_games
  // -------------------------------------------------------------------------
  server.tool(
    'list_proton_games',
    'List all games using Proton/Wine compatibility layer, with Proton version and prefix size',
    {},
    async () => {
      try {
        const manifests = await readAllManifests();
        const libraries = getLibraries();
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        // Gather compat overrides
        let overrideAppids = new Set<number>();
        try {
          const overrides = getCompatOverrides();
          overrideAppids = new Set(Object.keys(overrides).map((k) => parseInt(k, 10)));
        } catch {
          // no compat.vdf
        }

        // Scan compatdata directories across all libraries
        const compatdataAppids = new Set<number>();
        for (const lib of libraries) {
          if (!lib.mounted) continue;
          const compatDir = path.join(lib.path, 'steamapps', 'compatdata');
          try {
            const entries = fs.readdirSync(compatDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const id = parseInt(entry.name, 10);
              if (!isNaN(id)) compatdataAppids.add(id);
            }
          } catch {
            // skip
          }
        }

        // Union of override appids and compatdata appids, filtered to installed games
        const installedAppids = new Set(manifests.map((m) => m.appid));
        const protonAppids = new Set<number>();
        for (const id of overrideAppids) {
          if (installedAppids.has(id)) protonAppids.add(id);
        }
        for (const id of compatdataAppids) {
          if (installedAppids.has(id)) protonAppids.add(id);
        }

        const results: Array<{
          appid: number;
          name: string;
          protonVersion: string;
          prefixSize: string;
        }> = [];

        // Parse config.vdf once to get all proton version mappings
        const protonMappings = getAllProtonVersionMappings();

        for (const appid of protonAppids) {
          let protonVersion = protonMappings[appid] ?? 'Unknown';
          let prefixSize = 0;

          try {
            // Find the library containing this game for prefix size
            const manifest = manifests.find((m) => m.appid === appid);
            if (manifest) {
              prefixSize = getCompatDataSize(manifest.libraryPath, appid);
            }
          } catch {
            // skip
          }

          results.push({
            appid,
            name: nameMap.get(appid) ?? `Unknown (${appid})`,
            protonVersion,
            prefixSize: formatBytes(prefixSize),
          });
        }

        results.sort((a, b) => a.name.localeCompare(b.name));

        const output = {
          count: results.length,
          games: results,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error listing Proton games: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_proton_info
  // -------------------------------------------------------------------------
  server.tool(
    'get_proton_info',
    'Get detailed Proton/Wine compatibility info for a specific game',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const version = getGameProtonVersion(params.appid);

        if (!version) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No Proton/compatibility data found for appid ${params.appid}. This game may be native Linux or not installed.`,
              },
            ],
          };
        }

        // Find the library containing this game for prefix info
        const allManifests = await readAllManifests();
        const manifest = allManifests.find((m) => m.appid === params.appid);
        let prefixPath = '';
        let prefixSize = 0;
        if (manifest) {
          prefixPath = path.join(manifest.libraryPath, 'steamapps', 'compatdata', String(params.appid));
          prefixSize = getCompatDataSize(manifest.libraryPath, params.appid);
        }

        const output = {
          appid: params.appid,
          protonVersion: version,
          prefixPath,
          prefixSize: formatBytes(prefixSize),
          hasCompatData: prefixSize > 0,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error getting Proton info: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // list_proton_versions
  // -------------------------------------------------------------------------
  server.tool(
    'list_proton_versions',
    'List all installed Proton and GE-Proton versions with size and which games use each',
    {},
    async () => {
      try {
        const manifests = readAllManifests();
        const nameMap = new Map<number, string>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
        }

        // Build map: proton version -> list of games using it — parse config.vdf once
        const protonMappings = getAllProtonVersionMappings();
        const versionUsage = new Map<string, Array<{ appid: number; name: string }>>();
        for (const m of manifests) {
          const ver = protonMappings[m.appid];
          if (ver) {
            if (!versionUsage.has(ver)) {
              versionUsage.set(ver, []);
            }
            versionUsage.get(ver)!.push({
              appid: m.appid,
              name: m.name,
            });
          }
        }

        const installedVersions = getInstalledProtonVersions();

        const versions = installedVersions.map((v) => ({
          name: v.name,
          path: v.path,
          size: formatBytes(v.size),
          gamesUsing: versionUsage.get(v.name) ?? [],
        }));

        // Sort by name
        versions.sort((a, b) => a.name.localeCompare(b.name));

        const output = {
          count: versions.length,
          versions,
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
              text: `Error listing Proton versions: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_proton_db_rating
  // -------------------------------------------------------------------------
  server.tool(
    'get_proton_db_rating',
    'Fetch crowd-sourced ProtonDB compatibility rating for a game',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const url = `https://www.protondb.com/api/v1/reports/summaries/${params.appid}.json`;
        const response = await fetch(url);

        if (response.status === 404) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No ProtonDB data found for appid ${params.appid}. This game may not have been reported on ProtonDB.`,
              },
            ],
          };
        }

        if (!response.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `ProtonDB API returned status ${response.status} for appid ${params.appid}.`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as {
          bestReportedTier: string;
          confidence: string;
          score: number;
          tier: string;
          total: number;
          trendingTier: string;
        };

        const output = {
          appid: params.appid,
          tier: data.tier,
          bestReportedTier: data.bestReportedTier,
          trendingTier: data.trendingTier,
          confidence: data.confidence,
          totalReports: data.total,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error fetching ProtonDB rating: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // recommend_proton_version
  // -------------------------------------------------------------------------
  server.tool(
    'recommend_proton_version',
    'Suggest the best Proton version for a game based on ProtonDB data and locally installed versions',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        // Fetch ProtonDB summary
        let tier = 'unknown';
        let protonDbAvailable = false;
        try {
          const url = `https://www.protondb.com/api/v1/reports/summaries/${params.appid}.json`;
          const response = await fetch(url);
          if (response.ok) {
            const data = (await response.json()) as { tier: string };
            tier = data.tier;
            protonDbAvailable = true;
          }
        } catch {
          // ProtonDB unreachable
        }

        // Get currently configured Proton version for this game
        let currentVersion = 'Not configured';
        try {
          const ver = getGameProtonVersion(params.appid);
          if (ver) currentVersion = ver;
        } catch {
          // not configured
        }

        // Get installed Proton versions
        const installedVersions = getInstalledProtonVersions().map((v) => v.name);

        // Build recommendation
        let recommendation: string;
        if (!protonDbAvailable) {
          recommendation =
            'Could not fetch ProtonDB data. Check https://www.protondb.com/ manually for compatibility reports.';
        } else if (tier === 'native') {
          recommendation =
            'This game has a native Linux build. Proton is not needed unless the native version has issues.';
        } else if (tier === 'platinum' || tier === 'gold') {
          recommendation =
            'This game runs well with Proton. Your current configuration should be fine. ' +
            'If you experience minor issues, try updating to the latest stable Proton version.';
        } else if (tier === 'silver' || tier === 'bronze') {
          const hasGE = installedVersions.some(
            (v) => v.toLowerCase().includes('ge-proton') || v.toLowerCase().includes('ge_proton'),
          );
          recommendation =
            'This game has mixed compatibility reports. ' +
            (hasGE
              ? 'Try switching to one of your installed GE-Proton versions, which often include extra patches for problematic games.'
              : 'Consider installing GE-Proton (a community build with extra patches) for better compatibility. ' +
                'Download from https://github.com/GloriousEggroll/proton-ge-custom/releases and place in ~/.steam/root/compatibilitytools.d/');
        } else if (tier === 'borked') {
          recommendation =
            'WARNING: This game is reported as borked on ProtonDB, meaning it does not work or has severe issues. ' +
            'Check https://www.protondb.com/app/' +
            params.appid +
            ' for workarounds or wait for future Proton updates.';
        } else {
          recommendation =
            'ProtonDB tier is "' + tier + '". Check https://www.protondb.com/app/' + params.appid + ' for details.';
        }

        const output = {
          appid: params.appid,
          protonDbTier: tier,
          currentProtonVersion: currentVersion,
          installedVersions,
          recommendation,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error recommending Proton version: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // wine_prefix_info
  // -------------------------------------------------------------------------
  server.tool(
    'wine_prefix_info',
    'Inspect a Wine/Proton prefix for a game — size, Windows version, file count, user directories',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const libraryFolders = getLibraryFolders();

        // Find the compatdata directory across all library folders
        let compatDataDir = '';
        for (const libPath of libraryFolders) {
          const candidate = path.join(libPath, 'steamapps', 'compatdata', String(params.appid));
          if (fs.existsSync(candidate)) {
            compatDataDir = candidate;
            break;
          }
        }

        if (!compatDataDir) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No compatibility data (Wine prefix) found for appid ${params.appid}. The game may be native Linux or not installed.`,
              },
            ],
          };
        }

        const pfxDir = path.join(compatDataDir, 'pfx');
        const hasPfx = fs.existsSync(pfxDir);
        const hasDriveC = hasPfx && fs.existsSync(path.join(pfxDir, 'drive_c'));
        const hasSystemReg = hasPfx && fs.existsSync(path.join(pfxDir, 'system.reg'));

        // Parse Windows version from system.reg
        let windowsVersion = 'Unknown';
        if (hasSystemReg) {
          try {
            const regContent = fs.readFileSync(path.join(pfxDir, 'system.reg'), 'utf-8');

            const productNameMatch = regContent.match(/"ProductName"="([^"]+)"/);
            const csdVersionMatch = regContent.match(/"CSDVersion"="([^"]+)"/);

            if (productNameMatch) {
              windowsVersion = productNameMatch[1];
              if (csdVersionMatch && csdVersionMatch[1]) {
                windowsVersion += ' ' + csdVersionMatch[1];
              }
            }
          } catch {
            // Could not parse registry
          }
        }

        // Calculate prefix size and file count
        const prefixSize = getDirSize(compatDataDir);
        const fileCount = countFiles(compatDataDir);

        // List user directories under steamuser
        const userDirs: string[] = [];
        const steamUserDir = path.join(pfxDir, 'drive_c', 'users', 'steamuser');
        if (fs.existsSync(steamUserDir)) {
          try {
            const entries = fs.readdirSync(steamUserDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                userDirs.push(entry.name);
              }
            }
          } catch {
            // skip
          }
        }

        const output = {
          appid: params.appid,
          prefixPath: compatDataDir,
          prefixSize: formatBytes(prefixSize),
          prefixSizeBytes: prefixSize,
          windowsVersion,
          hasPfx,
          hasDriveC,
          hasSystemReg,
          fileCount,
          userDirs,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error inspecting Wine prefix: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_crash_logs
  // -------------------------------------------------------------------------
  server.tool(
    'get_crash_logs',
    'Look for crash dumps and error logs in a game\'s Wine/Proton prefix and Steam logs',
    {
      appid: z.number().describe('Steam application ID'),
      lines: z.number().default(50).describe('Number of lines to read from the end of log files (default 50)'),
    },
    async (params) => {
      try {
        const libraryFolders = getLibraryFolders();
        const tailLines = params.lines;

        // Find the compatdata directory
        let compatDataDir = '';
        for (const libPath of libraryFolders) {
          const candidate = path.join(libPath, 'steamapps', 'compatdata', String(params.appid));
          if (fs.existsSync(candidate)) {
            compatDataDir = candidate;
            break;
          }
        }

        const crashFiles: Array<{ path: string; size: string; type: string }> = [];
        const logContents: Array<{ path: string; content: string }> = [];

        // Helper to find files recursively matching extensions
        function findFiles(dir: string, extensions: string[]): string[] {
          const found: string[] = [];
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                found.push(...findFiles(fullPath, extensions));
              } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext)) {
                  found.push(fullPath);
                }
              }
            }
          } catch { /* skip inaccessible */ }
          return found;
        }

        // Helper to read the last N lines of a file
        function readTail(filePath: string, n: number): string {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const allLines = content.split('\n');
            const startLine = Math.max(0, allLines.length - n);
            return allLines.slice(startLine).join('\n');
          } catch {
            return '(unable to read file)';
          }
        }

        if (compatDataDir) {
          const pfxDir = path.join(compatDataDir, 'pfx');

          if (fs.existsSync(pfxDir)) {
            // Find .dmp files (crash dumps)
            const dmpFiles = findFiles(pfxDir, ['.dmp', '.mdmp']);
            for (const dmpPath of dmpFiles) {
              try {
                const stat = fs.statSync(dmpPath);
                crashFiles.push({
                  path: dmpPath,
                  size: formatBytes(stat.size),
                  type: 'crash_dump',
                });
              } catch { /* skip */ }
            }

            // Find .log files in the prefix
            const logFiles = findFiles(pfxDir, ['.log']);
            for (const logPath of logFiles) {
              try {
                const stat = fs.statSync(logPath);
                crashFiles.push({
                  path: logPath,
                  size: formatBytes(stat.size),
                  type: 'log',
                });
                if (stat.size > 0) {
                  logContents.push({
                    path: logPath,
                    content: readTail(logPath, tailLines),
                  });
                }
              } catch { /* skip */ }
            }

            // Check CrashDumps directory
            const crashDumpsDir = path.join(
              pfxDir,
              'drive_c',
              'users',
              'steamuser',
              'AppData',
              'Local',
              'CrashDumps',
            );
            if (fs.existsSync(crashDumpsDir)) {
              try {
                const entries = fs.readdirSync(crashDumpsDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (!entry.isFile()) continue;
                  const fullPath = path.join(crashDumpsDir, entry.name);
                  try {
                    const stat = fs.statSync(fullPath);
                    crashFiles.push({
                      path: fullPath,
                      size: formatBytes(stat.size),
                      type: 'crash_dump_dir',
                    });
                  } catch { /* skip */ }
                }
              } catch { /* skip */ }
            }

            // Check AppData/Local for log files
            const localAppDataDir = path.join(
              pfxDir,
              'drive_c',
              'users',
              'steamuser',
              'AppData',
              'Local',
            );
            if (fs.existsSync(localAppDataDir)) {
              const localLogs = findFiles(localAppDataDir, ['.log']);
              for (const logPath of localLogs) {
                // Avoid duplicates (already found during full pfx scan)
                if (crashFiles.some((f) => f.path === logPath)) continue;
                try {
                  const stat = fs.statSync(logPath);
                  crashFiles.push({
                    path: logPath,
                    size: formatBytes(stat.size),
                    type: 'appdata_log',
                  });
                  if (stat.size > 0) {
                    logContents.push({
                      path: logPath,
                      content: readTail(logPath, tailLines),
                    });
                  }
                } catch { /* skip */ }
              }
            }
          }
        }

        // Check Steam's logs directory for game-specific entries
        try {
          const steamDir = getSteamDir();
          const logsDir = path.join(steamDir, 'logs');
          if (fs.existsSync(logsDir)) {
            const logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log') || f.endsWith('.txt'));
            const appidStr = String(params.appid);
            for (const logFile of logFiles) {
              const logPath = path.join(logsDir, logFile);
              try {
                const content = fs.readFileSync(logPath, 'utf-8');
                // Check if the log mentions this appid
                if (content.includes(appidStr)) {
                  const stat = fs.statSync(logPath);
                  crashFiles.push({
                    path: logPath,
                    size: formatBytes(stat.size),
                    type: 'steam_log',
                  });
                  // Extract only lines mentioning this appid
                  const relevantLines = content
                    .split('\n')
                    .filter((line) => line.includes(appidStr))
                    .slice(-tailLines)
                    .join('\n');
                  if (relevantLines.length > 0) {
                    logContents.push({
                      path: logPath,
                      content: relevantLines,
                    });
                  }
                }
              } catch { /* skip */ }
            }
          }
        } catch {
          // Steam logs directory not accessible
        }

        const output = {
          appid: params.appid,
          totalFilesFound: crashFiles.length,
          crashFiles,
          logContents,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error searching for crash logs: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
