import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { isSteamRunning, getUserConfig, getLibraryFolders } from '../steam/paths.js';
import { readAllManifests } from '../steam/manifests.js';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import { formatBytes } from '../util/format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bitmask values for AppManifest stateFlags. */
const STATE_FLAGS: Record<number, string> = {
  1: 'Invalid',
  2: 'Uninstalled',
  4: 'FullyInstalled',
  16: 'Encrypted',
  32: 'Locked',
  64: 'FilesMissing',
  128: 'FilesCorrupt',
  256: 'UpdateRunning',
  512: 'UpdateRequired',
  1024: 'UpdateStarted',
  2048: 'Uninstalling',
  4096: 'BackupRunning',
  8192: 'Reconfiguring',
  16384: 'Validating',
  32768: 'AddingFiles',
  65536: 'Preallocating',
  131072: 'Downloading',
  262144: 'Staging',
  524288: 'Committing',
  1048576: 'UpdateStopping',
};

/**
 * Decode a stateFlags bitmask into an array of human-readable flag names.
 */
function decodeStateFlags(flags: number): string[] {
  const result: string[] = [];
  for (const [bit, label] of Object.entries(STATE_FLAGS)) {
    const bitNum = Number(bit);
    if ((flags & bitNum) !== 0) {
      result.push(label);
    }
  }
  return result.length > 0 ? result : ['Unknown'];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStatusTools(server: McpServer): void {
  server.tool(
    'steam_status',
    'Steam client status, download queue, or download progress',
    {
      action: z.enum(['status', 'queue', 'progress']).default('status'),
      appid: z.number().optional(),
    },
    async (params) => {
      switch (params.action) {
        case 'status': {
          try {
            const running = isSteamRunning();

            let user: { accountName: string; personaName: string; steamId64: string } | null = null;
            try {
              const config = getUserConfig();
              user = {
                accountName: config.accountName,
                personaName: config.personaName,
                steamId64: config.steamId64,
              };
            } catch {
              // user config may not be available
            }

            let gameCount = 0;
            try {
              const manifests = await readAllManifests();
              gameCount = manifests.length;
            } catch {
              // manifests may not be readable
            }

            const output = {
              steamRunning: running,
              currentUser: user,
              installedGames: gameCount,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error checking Steam status: ${msg}` }],
              isError: true,
            };
          }
        }

        case 'queue': {
          try {
            const manifests = await readAllManifests();

            // stateFlags === 4 means fully installed and normal — filter those out
            const nonNormal = manifests.filter((m) => m.stateFlags !== 4);

            const items = nonNormal.map((m) => ({
              appid: m.appid,
              name: m.name,
              stateFlags: m.stateFlags,
              states: decodeStateFlags(m.stateFlags),
              libraryPath: m.libraryPath,
            }));

            const output = {
              totalInstalled: manifests.length,
              nonNormalCount: items.length,
              games: items,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error checking download queue: ${msg}` }],
              isError: true,
            };
          }
        }

        case 'progress': {
          try {
            const folders = getLibraryFolders();

            interface DownloadInfo {
              appid: number;
              name: string;
              stateFlags: number;
              states: string[];
              bytesToDownload: number;
              bytesDownloaded: number;
              bytesToStage: number;
              bytesStaged: number;
              downloadProgress: string;
              stageProgress: string;
              overallProgress: string;
              libraryPath: string;
            }

            const results: DownloadInfo[] = [];

            for (const folder of folders) {
              const steamapps = path.join(folder, 'steamapps');
              if (!fs.existsSync(steamapps)) continue;

              let entries: string[];
              try {
                entries = fs.readdirSync(steamapps);
              } catch {
                continue;
              }

              for (const entry of entries) {
                if (!entry.startsWith('appmanifest_') || !entry.endsWith('.acf')) continue;

                const manifestPath = path.join(steamapps, entry);
                try {
                  // Read fresh — don't use cache since download bytes change rapidly
                  const content = fs.readFileSync(manifestPath, 'utf-8');
                  const parsed = parseVdf(content);
                  const state = (parsed['AppState'] ?? parsed) as VdfObject;

                  const appid = parseInt(String(state['appid'] ?? '0'), 10);
                  const flags = parseInt(String(state['StateFlags'] ?? '0'), 10);

                  // If filtering by appid, skip non-matching
                  if (params.appid !== undefined && appid !== params.appid) continue;

                  // If no appid filter, only show non-fully-installed games
                  if (params.appid === undefined && flags === 4) continue;

                  const bytesToDownload = parseInt(String(state['BytesToDownload'] ?? '0'), 10);
                  const bytesDownloaded = parseInt(String(state['BytesDownloaded'] ?? '0'), 10);
                  const bytesToStage = parseInt(String(state['BytesToStage'] ?? '0'), 10);
                  const bytesStaged = parseInt(String(state['BytesStaged'] ?? '0'), 10);

                  const dlPct = bytesToDownload > 0
                    ? ((bytesDownloaded / bytesToDownload) * 100).toFixed(1) + '%'
                    : 'N/A';
                  const stagePct = bytesToStage > 0
                    ? ((bytesStaged / bytesToStage) * 100).toFixed(1) + '%'
                    : 'N/A';

                  // Overall = weighted average of download + staging
                  const totalBytes = bytesToDownload + bytesToStage;
                  const doneBytes = bytesDownloaded + bytesStaged;
                  const overallPct = totalBytes > 0
                    ? ((doneBytes / totalBytes) * 100).toFixed(1) + '%'
                    : flags === 4 ? '100%' : 'N/A';

                  results.push({
                    appid,
                    name: String(state['name'] ?? `Unknown (${appid})`),
                    stateFlags: flags,
                    states: decodeStateFlags(flags),
                    bytesToDownload,
                    bytesDownloaded,
                    bytesToStage,
                    bytesStaged,
                    downloadProgress: `${formatBytes(bytesDownloaded)} / ${formatBytes(bytesToDownload)} (${dlPct})`,
                    stageProgress: `${formatBytes(bytesStaged)} / ${formatBytes(bytesToStage)} (${stagePct})`,
                    overallProgress: overallPct,
                    libraryPath: folder,
                  });
                } catch {
                  // skip unreadable manifests
                }
              }
            }

            if (results.length === 0) {
              const msg = params.appid !== undefined
                ? `No manifest found for appid ${params.appid}, or it is fully installed.`
                : 'No active downloads or updates.';
              return {
                content: [{ type: 'text' as const, text: msg }],
              };
            }

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error checking download progress: ${msg}` }],
              isError: true,
            };
          }
        }
      }
    },
  );
}
