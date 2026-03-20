import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readAllManifests } from '../steam/manifests.js';
import { getAllPlaytimes } from '../steam/userdata.js';
import { formatPlaytime, formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Two weeks in seconds. */
const TWO_WEEKS_SECONDS = 14 * 24 * 60 * 60;

/** Batch size for store API name lookups. */
const STORE_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve game names for appids not found in local manifests by querying
 * the Steam store API. Fetches in parallel batches.
 */
async function resolveNames(appids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (appids.length === 0) return names;

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < appids.length; i += STORE_BATCH_SIZE) {
    const batch = appids.slice(i, i + STORE_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (appid) => {
        try {
          const resp = await fetch(
            `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`,
          );
          if (!resp.ok) return;
          const data = (await resp.json()) as Record<
            string,
            { success: boolean; data?: { name?: string } }
          >;
          const entry = data[String(appid)];
          if (entry?.success && entry.data?.name) {
            names.set(appid, entry.data.name);
          }
        } catch {
          // skip failures silently
        }
      }),
    );
    void results; // consumed via side effects on the names map
  }

  return names;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHistoryTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_play_history
  // -------------------------------------------------------------------------
  server.tool(
    'get_play_history',
    'Get playtime information across ALL games (installed and uninstalled) from localconfig.vdf, with sorting, totals, and recently-played stats',
    {
      sort_by: z
        .enum(['playtime', 'last_played', 'name'])
        .default('playtime')
        .describe('Sort field (default: playtime)'),
      limit: z.number().default(20).describe('Max results to return (default 20)'),
      installed_only: z
        .boolean()
        .default(false)
        .describe('Only show installed games (default: false — shows all games with playtime)'),
      resolve_names: z
        .boolean()
        .default(true)
        .describe('Look up names for uninstalled games via Steam store API (default: true, may be slow for large libraries)'),
    },
    async (params) => {
      try {
        // Build name map from installed manifests
        const manifests = await readAllManifests();
        const nameMap = new Map<number, string>();
        const installedSet = new Set<number>();
        for (const m of manifests) {
          nameMap.set(m.appid, m.name);
          installedSet.add(m.appid);
        }

        // Get ALL playtime data from localconfig
        const allPlaytimes = getAllPlaytimes();

        // Filter to installed only if requested
        const playtimes = params.installed_only
          ? allPlaytimes.filter((p) => installedSet.has(p.appid))
          : allPlaytimes;

        // Find appids that need name resolution
        if (params.resolve_names && !params.installed_only) {
          const unknownAppids = playtimes
            .filter((p) => !nameMap.has(p.appid))
            .sort((a, b) => b.playtime - a.playtime)
            .slice(0, params.limit) // only resolve names for games we'll actually show
            .map((p) => p.appid);

          const resolvedNames = await resolveNames(unknownAppids);
          for (const [appid, name] of resolvedNames) {
            nameMap.set(appid, name);
          }
        }

        // Build game entries
        interface GameEntry {
          appid: number;
          name: string;
          playtimeMinutes: number;
          playtime: string;
          lastPlayedTimestamp: number;
          lastPlayed: string;
          installed: boolean;
        }

        const games: GameEntry[] = playtimes.map((p) => ({
          appid: p.appid,
          name: nameMap.get(p.appid) ?? `Unknown (${p.appid})`,
          playtimeMinutes: p.playtime,
          playtime: formatPlaytime(p.playtime),
          lastPlayedTimestamp: p.lastPlayed,
          lastPlayed: formatTimestamp(p.lastPlayed),
          installed: installedSet.has(p.appid),
        }));

        // Sort
        switch (params.sort_by) {
          case 'playtime':
            games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
            break;
          case 'last_played':
            games.sort((a, b) => b.lastPlayedTimestamp - a.lastPlayedTimestamp);
            break;
          case 'name':
            games.sort((a, b) => a.name.localeCompare(b.name));
            break;
        }

        // Calculate totals
        const totalPlaytimeMinutes = games.reduce((sum, g) => sum + g.playtimeMinutes, 0);

        const now = Math.floor(Date.now() / 1000);
        const twoWeeksAgo = now - TWO_WEEKS_SECONDS;
        const recentlyPlayed = games.filter((g) => g.lastPlayedTimestamp > twoWeeksAgo);

        // Most played game
        const mostPlayed =
          games.length > 0
            ? (() => {
                const top = games.reduce((a, b) =>
                  a.playtimeMinutes > b.playtimeMinutes ? a : b,
                );
                return { name: top.name, playtime: formatPlaytime(top.playtimeMinutes) };
              })()
            : null;

        // Apply limit
        const limited = games.slice(0, params.limit);

        const output = {
          totalPlaytime: formatPlaytime(totalPlaytimeMinutes),
          totalPlaytimeMinutes,
          totalGames: games.length,
          recentlyPlayedCount: recentlyPlayed.length,
          mostPlayed,
          games: limited.map(({ appid, name, playtime, lastPlayed, installed }) => ({
            appid,
            name,
            playtime,
            lastPlayed,
            installed,
          })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error reading play history: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
