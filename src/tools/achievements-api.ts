import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { formatTimestamp } from '../util/format.js';

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

interface GlobalAchievementEntry {
  name: string;
  percent: number;
}

interface GlobalAchievementResponse {
  achievementpercentages: {
    achievements: GlobalAchievementEntry[];
  };
}

interface SchemaAchievement {
  name: string;
  defaultvalue: number;
  displayName: string;
  hidden: number;
  description: string;
  icon: string;
  icongray: string;
}

interface SchemaStat {
  name: string;
  defaultvalue: number;
  displayName: string;
}

interface SchemaResponse {
  game: {
    gameName: string;
    availableGameStats?: {
      achievements?: SchemaAchievement[];
      stats?: SchemaStat[];
    };
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAchievementsApiTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_player_achievements
  // -------------------------------------------------------------------------
  server.tool(
    'get_player_achievements',
    'Fetch achievement unlock status for a player on a specific game from the Steam Web API',
    {
      appid: z.number().describe('Steam application ID'),
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the player (defaults to current user)'),
    },
    async (params) => {
      try {
        const { appid } = params;
        const steamid = params.steamid ?? getUserConfig().steamId64;

        let data: PlayerAchievementsResponse;
        try {
          data = await steamApiRequest<PlayerAchievementsResponse>(
            'ISteamUserStats',
            'GetPlayerAchievements',
            'v1',
            { steamid, appid },
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Could not fetch achievements for appid ${appid}. The game may have no achievements or the profile may be private. Error: ${msg}`,
              },
            ],
            isError: true,
          };
        }

        const { playerstats } = data;

        if (!playerstats.success || !playerstats.achievements) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Game "${playerstats.gameName || appid}" has no achievements or the API returned success=false.`,
              },
            ],
          };
        }

        const achievements = playerstats.achievements;
        const total = achievements.length;
        const unlocked = achievements.filter((a) => a.achieved === 1);
        const locked = achievements.filter((a) => a.achieved === 0);
        const pct = total > 0 ? ((unlocked.length / total) * 100).toFixed(1) : '0.0';

        // Sort unlocked by unlock time descending (most recent first)
        unlocked.sort((a, b) => b.unlocktime - a.unlocktime);

        // Sort locked alphabetically by name/apiname
        locked.sort((a, b) => {
          const nameA = a.name ?? a.apiname;
          const nameB = b.name ?? b.apiname;
          return nameA.localeCompare(nameB);
        });

        const unlockedList = unlocked.map((a) => ({
          name: a.name ?? a.apiname,
          apiname: a.apiname,
          unlockedAt: formatTimestamp(a.unlocktime),
        }));

        const lockedList = locked.map((a) => ({
          name: a.name ?? a.apiname,
          apiname: a.apiname,
          description: a.description ?? null,
        }));

        const output = {
          gameName: playerstats.gameName,
          steamID: playerstats.steamID,
          completion: `${unlocked.length}/${total} (${pct}%)`,
          totalAchievements: total,
          unlockedCount: unlocked.length,
          lockedCount: locked.length,
          unlocked: unlockedList,
          locked: lockedList,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching player achievements: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_global_achievement_stats
  // -------------------------------------------------------------------------
  server.tool(
    'get_global_achievement_stats',
    'Fetch global achievement unlock percentages for a game, merged with display names from the game schema',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const { appid } = params;

        // Fetch global percentages and schema in parallel
        const [globalData, schemaData] = await Promise.all([
          steamApiRequest<GlobalAchievementResponse>(
            'ISteamUserStats',
            'GetGlobalAchievementPercentagesForApp',
            'v2',
            { gameid: appid },
          ),
          steamApiRequest<SchemaResponse>(
            'ISteamUserStats',
            'GetSchemaForGame',
            'v2',
            { appid },
          ),
        ]);

        const percentages = globalData.achievementpercentages?.achievements ?? [];
        const schemaAchievements = schemaData.game?.availableGameStats?.achievements ?? [];
        const gameName = schemaData.game?.gameName ?? `App ${appid}`;

        // Build a lookup map from schema
        const schemaMap = new Map<string, SchemaAchievement>();
        for (const sa of schemaAchievements) {
          schemaMap.set(sa.name, sa);
        }

        // Merge and sort by percent descending
        const merged = percentages
          .map((entry) => {
            const schema = schemaMap.get(entry.name);
            return {
              name: entry.name,
              displayName: schema?.displayName ?? entry.name,
              percent: Math.round(entry.percent * 100) / 100,
              description: schema?.description ?? null,
            };
          })
          .sort((a, b) => b.percent - a.percent);

        const output = {
          gameName,
          appid,
          totalAchievements: merged.length,
          achievements: merged,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error fetching global achievement stats: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_game_schema
  // -------------------------------------------------------------------------
  server.tool(
    'get_game_schema',
    'Fetch the full achievement and stat schema for a game from the Steam Web API',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const { appid } = params;

        const data = await steamApiRequest<SchemaResponse>(
          'ISteamUserStats',
          'GetSchemaForGame',
          'v2',
          { appid },
        );

        const game = data.game;
        const gameName = game?.gameName ?? `App ${appid}`;
        const gameStats = game?.availableGameStats;
        const achievements = gameStats?.achievements ?? [];
        const stats = gameStats?.stats ?? [];

        const achievementList = achievements.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          description: a.description || null,
          hidden: a.hidden === 1,
        }));

        const statList = stats.map((s) => ({
          name: s.name,
          displayName: s.displayName,
        }));

        const output = {
          gameName,
          appid,
          achievementCount: achievementList.length,
          statCount: statList.length,
          achievements: achievementList,
          stats: statList,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching game schema: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
