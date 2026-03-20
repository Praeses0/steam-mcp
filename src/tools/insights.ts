import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { getAllPlaytimes } from '../steam/userdata.js';
import { formatPlaytime, formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OwnedGame {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_2weeks?: number;
  img_icon_url: string;
  has_community_visible_stats?: boolean;
}

interface OwnedGamesResponse {
  response: {
    game_count: number;
    games: OwnedGame[];
  };
}

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Batch size for parallel achievement fetches. */
const ACHIEVEMENT_BATCH_SIZE = 10;

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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerInsightsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // completion_stats
  // -------------------------------------------------------------------------
  server.tool(
    'completion_stats',
    'Analyze achievement completion rates across your top games by playtime. Shows which games you have fully completed, your average completion rate, and games closest to 100%.',
    {
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the player (defaults to current user)'),
      limit: z
        .number()
        .default(20)
        .describe('Number of top games (by playtime) to check for achievements (default 20)'),
    },
    async (params) => {
      try {
        const steamid = params.steamid ?? getUserConfig().steamId64;

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
          .slice(0, params.limit);

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
    },
  );

  // -------------------------------------------------------------------------
  // gaming_timeline
  // -------------------------------------------------------------------------
  server.tool(
    'gaming_timeline',
    'Build a month-by-month timeline of your gaming activity, showing which games were played each month and total playtime per month.',
    {
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the player (defaults to current user — used for name lookups)'),
      year: z
        .number()
        .optional()
        .describe('Filter to a specific year (e.g. 2025). Omit to show all time.'),
      limit: z
        .number()
        .default(30)
        .describe('Max number of months to return (default 30)'),
    },
    async (params) => {
      try {
        const steamid = params.steamid ?? getUserConfig().steamId64;

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
          .slice(0, params.limit);

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
    },
  );

  // -------------------------------------------------------------------------
  // year_in_review
  // -------------------------------------------------------------------------
  server.tool(
    'year_in_review',
    'Generate a year-in-review summary for a specific year: games played, total playtime, top games, and achievement completion for your most-played titles.',
    {
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the player (defaults to current user)'),
      year: z.number().describe('The year to review (e.g. 2025)'),
    },
    async (params) => {
      try {
        const steamid = params.steamid ?? getUserConfig().steamId64;
        const { year } = params;

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
    },
  );
}
