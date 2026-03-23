import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { readAllManifests } from '../steam/manifests.js';
import { getUserConfig } from '../steam/paths.js';
import { getAllPlaytimes } from '../steam/userdata.js';
import { formatPlaytime, formatTimestamp } from '../util/format.js';
import type { OwnedGamesResponse } from '../steam/api-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlayerAchievement {
  apiname: string;
  achieved: number;
  unlocktime: number;
  name?: string;
  description?: string;
}

interface PlayerAchievementsResponse {
  playerstats: {
    steamID: string;
    gameName: string;
    achievements: PlayerAchievement[];
    success: boolean;
  };
}

interface GameCompletionInfo {
  appid: number;
  name: string;
  unlocked: number;
  total: number;
  percentage: number;
}

interface ExportRow {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_formatted: string;
  last_played: string;
  achievements_unlocked: number | null;
  achievements_total: number | null;
  completion_pct: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Batch size for parallel achievement fetches. */
const ACHIEVEMENT_BATCH_SIZE = 10;

/** Two weeks in seconds. */
const TWO_WEEKS_SECONDS = 14 * 24 * 60 * 60;

/** Batch size for store API name lookups. */
const STORE_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch achievement completion data for a single game.
 * Returns null if the game has no achievements or the request fails.
 */
async function fetchGameCompletion(
  appid: number,
  name: string,
  steamid: string,
): Promise<GameCompletionInfo | null> {
  try {
    const data = await steamApiRequest<PlayerAchievementsResponse>(
      'ISteamUserStats',
      'GetPlayerAchievements',
      'v1',
      { steamid, appid },
    );

    const { playerstats } = data;
    if (!playerstats.success || !playerstats.achievements) return null;

    const achievements = playerstats.achievements;
    const total = achievements.length;
    if (total === 0) return null;

    const unlocked = achievements.filter((a) => a.achieved === 1).length;
    const percentage = Math.round((unlocked / total) * 10000) / 100;

    return { appid, name, unlocked, total, percentage };
  } catch {
    // Game has no achievements, profile is private, or API error — skip
    return null;
  }
}

/**
 * Fetch achievement data for multiple games in parallel batches.
 */
async function fetchCompletionBatched(
  games: Array<{ appid: number; name: string }>,
  steamid: string,
): Promise<GameCompletionInfo[]> {
  const results: GameCompletionInfo[] = [];

  for (let i = 0; i < games.length; i += ACHIEVEMENT_BATCH_SIZE) {
    const batch = games.slice(i, i + ACHIEVEMENT_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((g) => fetchGameCompletion(g.appid, g.name, steamid)),
    );

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value !== null) {
        results.push(result.value);
      }
    }
  }

  return results;
}

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

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: ExportRow): string {
  return [
    String(row.appid),
    escapeCsvField(row.name),
    String(row.playtime_forever),
    escapeCsvField(row.playtime_formatted),
    escapeCsvField(row.last_played),
    row.achievements_unlocked !== null ? String(row.achievements_unlocked) : '',
    row.achievements_total !== null ? String(row.achievements_total) : '',
    row.completion_pct !== null ? row.completion_pct : '',
  ].join(',');
}

async function fetchAchievements(
  appid: number,
  steamid: string,
): Promise<{ unlocked: number; total: number } | null> {
  try {
    const data = await steamApiRequest<PlayerAchievementsResponse>(
      'ISteamUserStats',
      'GetPlayerAchievements',
      'v1',
      { steamid, appid },
    );
    const achievements = data.playerstats?.achievements ?? [];
    if (achievements.length === 0) return null;
    const unlocked = achievements.filter((a) => a.achieved === 1).length;
    return { unlocked, total: achievements.length };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerInsightsTools(server: McpServer): void {
  server.tool(
    'insights',
    'Completion stats, timeline, year review, play history, export',
    {
      action: z.enum(['completion', 'timeline', 'year_review', 'play_history', 'export']),
      steamid: z.string().optional(),
      year: z.number().optional(),
      format: z.enum(['json', 'csv']).optional(),
      output: z.string().optional(),
      limit: z.number().optional(),
      sort_by: z.enum(['playtime', 'last_played', 'name']).optional(),
      installed_only: z.boolean().optional(),
      resolve_names: z.boolean().optional(),
      include_playtime: z.boolean().optional(),
      include_achievements: z.boolean().optional(),
    },
    async (params) => {
      switch (params.action) {
        // -------------------------------------------------------------------
        // completion
        // -------------------------------------------------------------------
        case 'completion': {
          try {
            const steamid = params.steamid ?? getUserConfig().steamId64;
            const limit = params.limit ?? 20;

            // Get owned games from API
            const ownedData = await steamApiRequest<OwnedGamesResponse>(
              'IPlayerService',
              'GetOwnedGames',
              'v1',
              { steamid, include_appinfo: 1, include_played_free_games: 1 },
            );

            const allGames = ownedData.response.games ?? [];

            // Filter to games with community stats, sort by playtime, take top N
            const candidates = allGames
              .filter((g) => g.has_community_visible_stats)
              .sort((a, b) => b.playtime_forever - a.playtime_forever)
              .slice(0, limit);

            if (candidates.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No games with community stats found for this user.',
                  },
                ],
              };
            }

            // Fetch achievement data in parallel batches
            const completions = await fetchCompletionBatched(
              candidates.map((g) => ({ appid: g.appid, name: g.name })),
              steamid,
            );

            // Sort by completion percentage descending
            completions.sort((a, b) => b.percentage - a.percentage);

            const fullyCompleted = completions.filter((g) => g.percentage === 100);
            const totalPercentage = completions.reduce((sum, g) => sum + g.percentage, 0);
            const averageCompletion =
              completions.length > 0
                ? Math.round((totalPercentage / completions.length) * 100) / 100
                : 0;

            // Find games closest to 100% (but not already 100%)
            const closestTo100 = completions
              .filter((g) => g.percentage > 0 && g.percentage < 100)
              .sort((a, b) => b.percentage - a.percentage)
              .slice(0, 5);

            const output = {
              games_checked: completions.length,
              games_with_stats_attempted: candidates.length,
              fully_completed: fullyCompleted.length,
              average_completion: `${averageCompletion}%`,
              closest_to_100: closestTo100.map((g) => ({
                appid: g.appid,
                name: g.name,
                completion: `${g.unlocked}/${g.total} (${g.percentage}%)`,
                remaining: g.total - g.unlocked,
              })),
              games: completions.map((g) => ({
                appid: g.appid,
                name: g.name,
                unlocked: g.unlocked,
                total: g.total,
                percentage: `${g.percentage}%`,
              })),
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error computing completion stats: ${msg}` }],
              isError: true,
            };
          }
        }

        // -------------------------------------------------------------------
        // timeline
        // -------------------------------------------------------------------
        case 'timeline': {
          try {
            const steamid = params.steamid ?? getUserConfig().steamId64;
            const limit = params.limit ?? 30;

            // Get local playtime data
            const allPlaytimes = getAllPlaytimes();

            // Build a name map from the API
            const nameMap = new Map<number, string>();
            try {
              const ownedData = await steamApiRequest<OwnedGamesResponse>(
                'IPlayerService',
                'GetOwnedGames',
                'v1',
                { steamid, include_appinfo: 1, include_played_free_games: 1 },
              );
              for (const g of ownedData.response.games ?? []) {
                nameMap.set(g.appid, g.name);
              }
            } catch {
              // API may fail — proceed with appids only
            }

            // Build timeline entries
            interface TimelineEntry {
              appid: number;
              name: string;
              lastPlayed: number;
              lastPlayedFormatted: string;
              playtime: string;
              playtimeMinutes: number;
            }

            let entries: TimelineEntry[] = allPlaytimes
              .filter((p) => p.lastPlayed > 0)
              .map((p) => ({
                appid: p.appid,
                name: nameMap.get(p.appid) ?? `Unknown (${p.appid})`,
                lastPlayed: p.lastPlayed,
                lastPlayedFormatted: formatTimestamp(p.lastPlayed),
                playtime: formatPlaytime(p.playtime),
                playtimeMinutes: p.playtime,
              }));

            // Filter by year if specified
            if (params.year) {
              const yearStart = new Date(params.year, 0, 1).getTime() / 1000;
              const yearEnd = new Date(params.year + 1, 0, 1).getTime() / 1000;
              entries = entries.filter((e) => e.lastPlayed >= yearStart && e.lastPlayed < yearEnd);
            }

            // Sort by lastPlayed descending
            entries.sort((a, b) => b.lastPlayed - a.lastPlayed);

            // Group by month (YYYY-MM)
            const monthGroups = new Map<
              string,
              { games: TimelineEntry[]; totalPlaytimeMinutes: number }
            >();

            for (const entry of entries) {
              const date = new Date(entry.lastPlayed * 1000);
              const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

              let group = monthGroups.get(monthKey);
              if (!group) {
                group = { games: [], totalPlaytimeMinutes: 0 };
                monthGroups.set(monthKey, group);
              }
              group.games.push(entry);
              group.totalPlaytimeMinutes += entry.playtimeMinutes;
            }

            // Convert to sorted array (most recent month first), apply limit
            const sortedMonths = Array.from(monthGroups.entries())
              .sort(([a], [b]) => b.localeCompare(a))
              .slice(0, limit);

            const timeline = sortedMonths.map(([month, group]) => ({
              month,
              games_count: group.games.length,
              total_playtime: formatPlaytime(group.totalPlaytimeMinutes),
              games: group.games.map((g) => ({
                appid: g.appid,
                name: g.name,
                playtime: g.playtime,
                last_played: g.lastPlayedFormatted,
              })),
            }));

            const output = {
              total_months: sortedMonths.length,
              total_games: entries.length,
              ...(params.year ? { filtered_year: params.year } : {}),
              timeline,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error building gaming timeline: ${msg}` }],
              isError: true,
            };
          }
        }

        // -------------------------------------------------------------------
        // year_review
        // -------------------------------------------------------------------
        case 'year_review': {
          try {
            const steamid = params.steamid ?? getUserConfig().steamId64;
            const year = params.year;

            if (year === undefined) {
              return {
                content: [{ type: 'text' as const, text: 'Error: year is required for year_review action.' }],
                isError: true,
              };
            }

            const yearStart = new Date(year, 0, 1).getTime() / 1000;
            const yearEnd = new Date(year + 1, 0, 1).getTime() / 1000;

            // Get owned games from API for names and playtime
            const ownedData = await steamApiRequest<OwnedGamesResponse>(
              'IPlayerService',
              'GetOwnedGames',
              'v1',
              { steamid, include_appinfo: 1, include_played_free_games: 1 },
            );

            const allOwnedGames = ownedData.response.games ?? [];
            const nameMap = new Map<number, string>();
            const apiPlaytimeMap = new Map<number, number>();
            for (const g of allOwnedGames) {
              nameMap.set(g.appid, g.name);
              apiPlaytimeMap.set(g.appid, g.playtime_forever);
            }

            // Get local playtime data
            const allPlaytimes = getAllPlaytimes();

            // Filter to games active in the target year
            const yearGames = allPlaytimes
              .filter((p) => p.lastPlayed >= yearStart && p.lastPlayed < yearEnd)
              .map((p) => ({
                appid: p.appid,
                name: nameMap.get(p.appid) ?? `Unknown (${p.appid})`,
                playtimeMinutes: apiPlaytimeMap.get(p.appid) ?? p.playtime,
                lastPlayed: p.lastPlayed,
              }));

            // Sort by playtime descending
            yearGames.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);

            const totalPlaytimeMinutes = yearGames.reduce((sum, g) => sum + g.playtimeMinutes, 0);

            // Top 5 games by playtime
            const top5 = yearGames.slice(0, 5).map((g) => ({
              appid: g.appid,
              name: g.name,
              playtime: formatPlaytime(g.playtimeMinutes),
            }));

            // Fetch achievement data for top 10 games
            const top10ForAchievements = yearGames
              .slice(0, 10)
              .map((g) => ({ appid: g.appid, name: g.name }));

            const achievementResults = await fetchCompletionBatched(top10ForAchievements, steamid);

            const achievementSummary = achievementResults.map((g) => ({
              appid: g.appid,
              name: g.name,
              completion: `${g.unlocked}/${g.total} (${g.percentage}%)`,
              unlocked: g.unlocked,
              total: g.total,
            }));

            const totalAchievementsUnlocked = achievementResults.reduce(
              (sum, g) => sum + g.unlocked,
              0,
            );
            const totalAchievementsTotal = achievementResults.reduce((sum, g) => sum + g.total, 0);

            // Group by month for monthly breakdown
            const monthCounts = new Map<string, number>();
            for (const g of yearGames) {
              const date = new Date(g.lastPlayed * 1000);
              const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
              monthCounts.set(monthKey, (monthCounts.get(monthKey) ?? 0) + 1);
            }
            const monthlyActivity = Array.from(monthCounts.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([month, count]) => ({ month, games_active: count }));

            const output = {
              year,
              games_played_count: yearGames.length,
              total_playtime: formatPlaytime(totalPlaytimeMinutes),
              total_playtime_minutes: totalPlaytimeMinutes,
              playtime_note:
                'Playtime is total all-time playtime for these games, not year-specific (Steam API limitation).',
              top_5_games: top5,
              monthly_activity: monthlyActivity,
              achievement_stats: {
                games_checked: achievementResults.length,
                total_unlocked: totalAchievementsUnlocked,
                total_available: totalAchievementsTotal,
                completion:
                  totalAchievementsTotal > 0
                    ? `${Math.round((totalAchievementsUnlocked / totalAchievementsTotal) * 10000) / 100}%`
                    : 'N/A',
                games: achievementSummary,
              },
              all_games: yearGames.map((g) => ({
                appid: g.appid,
                name: g.name,
                playtime: formatPlaytime(g.playtimeMinutes),
                last_played: formatTimestamp(g.lastPlayed),
              })),
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: 'text' as const, text: `Error generating year in review: ${msg}` }],
              isError: true,
            };
          }
        }

        // -------------------------------------------------------------------
        // play_history
        // -------------------------------------------------------------------
        case 'play_history': {
          try {
            const sortBy = params.sort_by ?? 'playtime';
            const limit = params.limit ?? 20;
            const installedOnly = params.installed_only ?? false;
            const doResolveNames = params.resolve_names ?? true;

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
            const playtimes = installedOnly
              ? allPlaytimes.filter((p) => installedSet.has(p.appid))
              : allPlaytimes;

            // Find appids that need name resolution
            if (doResolveNames && !installedOnly) {
              const unknownAppids = playtimes
                .filter((p) => !nameMap.has(p.appid))
                .sort((a, b) => b.playtime - a.playtime)
                .slice(0, limit) // only resolve names for games we'll actually show
                .map((p) => p.appid);

              const resolvedNameMap = await resolveNames(unknownAppids);
              for (const [appid, name] of resolvedNameMap) {
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
            switch (sortBy) {
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
            const limited = games.slice(0, limit);

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
        }

        // -------------------------------------------------------------------
        // export
        // -------------------------------------------------------------------
        case 'export': {
          try {
            const format = params.format ?? 'json';
            const outputPath = params.output;
            const includePlaytime = params.include_playtime ?? true;
            const includeAchievements = params.include_achievements ?? false;

            if (!outputPath) {
              return {
                content: [{ type: 'text' as const, text: 'Error: output is required for export action.' }],
                isError: true,
              };
            }

            const config = getUserConfig();
            const steamid = config.steamId64;

            // Fetch owned games from API
            const ownedData = await steamApiRequest<OwnedGamesResponse>(
              'IPlayerService',
              'GetOwnedGames',
              'v1',
              {
                steamid,
                include_appinfo: 1,
                include_played_free_games: 1,
              },
            );

            const games = ownedData.response.games ?? [];

            // Merge with local playtime data
            const localPlaytimes = includePlaytime ? getAllPlaytimes() : [];
            const localMap = new Map<number, { playtime: number; lastPlayed: number }>();
            for (const lp of localPlaytimes) {
              localMap.set(lp.appid, { playtime: lp.playtime, lastPlayed: lp.lastPlayed });
            }

            // Build rows
            const rows: ExportRow[] = games.map((g) => {
              const local = localMap.get(g.appid);
              const playtime = g.playtime_forever || local?.playtime || 0;
              const lastPlayed = local?.lastPlayed ?? 0;

              return {
                appid: g.appid,
                name: g.name,
                playtime_forever: playtime,
                playtime_formatted: formatPlaytime(playtime),
                last_played: lastPlayed > 0 ? formatTimestamp(lastPlayed) : 'Never',
                achievements_unlocked: null,
                achievements_total: null,
                completion_pct: null,
              };
            });

            // Optionally fetch achievements in batches
            if (includeAchievements) {
              const batchSize = 10;
              for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const results = await Promise.all(
                  batch.map((row) => fetchAchievements(row.appid, steamid)),
                );
                for (let j = 0; j < batch.length; j++) {
                  const result = results[j];
                  if (result) {
                    batch[j].achievements_unlocked = result.unlocked;
                    batch[j].achievements_total = result.total;
                    batch[j].completion_pct =
                      result.total > 0
                        ? ((result.unlocked / result.total) * 100).toFixed(1) + '%'
                        : '0.0%';
                  }
                }
              }
            }

            // Sort by playtime descending
            rows.sort((a, b) => b.playtime_forever - a.playtime_forever);

            // Write to file
            const resolvedPath = path.resolve(outputPath);
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }

            if (format === 'json') {
              fs.writeFileSync(resolvedPath, JSON.stringify(rows, null, 2), 'utf-8');
            } else {
              const header =
                'appid,name,playtime_forever,playtime_formatted,last_played,achievements_unlocked,achievements_total,completion_pct';
              const csvRows = rows.map(toCsvRow);
              fs.writeFileSync(resolvedPath, [header, ...csvRows].join('\n'), 'utf-8');
            }

            const output = {
              path: resolvedPath,
              format,
              game_count: rows.length,
              include_playtime: includePlaytime,
              include_achievements: includeAchievements,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error exporting library: ${msg}` },
              ],
              isError: true,
            };
          }
        }
      }
    },
  );
}
