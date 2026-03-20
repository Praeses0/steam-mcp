import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarfull: string;
  personastate: number;
  gameextrainfo?: string;
  gameid?: string;
  loccountrycode?: string;
  timecreated: number;
  lastlogoff: number;
}

interface PlayerSummariesResponse {
  response: {
    players: PlayerSummary[];
  };
}

interface BadgeInfo {
  badgeid: number;
  level: number;
  completion_time: number;
  xp: number;
  scarcity: number;
}

interface BadgesResponse {
  response: {
    badges: BadgeInfo[];
    player_xp: number;
    player_level: number;
    player_xp_needed_current_level: number;
    player_xp_needed_next_level: number;
  };
}

interface LevelResponse {
  response: {
    player_level: number;
  };
}

interface PlayerBan {
  SteamId: string;
  CommunityBanned: boolean;
  VACBanned: boolean;
  NumberOfVACBans: number;
  DaysSinceLastBan: number;
  NumberOfGameBans: number;
  EconomyBan: string;
}

interface PlayerBansResponse {
  players: PlayerBan[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERSONA_STATES: Record<number, string> = {
  0: 'Offline',
  1: 'Online',
  2: 'Busy',
  3: 'Away',
  4: 'Snooze',
  5: 'Looking to trade',
  6: 'Looking to play',
};

function resolveDefaultSteamId(steamid?: string): string {
  if (steamid) return steamid;
  return getUserConfig().steamId64;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProfileTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_player_summary
  // -------------------------------------------------------------------------
  server.tool(
    'get_player_summary',
    'Fetch a Steam player profile summary including online status, currently playing game, profile URL, and account age',
    {
      steamid: z.string().optional().describe('Steam ID 64 (defaults to current user)'),
    },
    async (params) => {
      try {
        const steamid = resolveDefaultSteamId(params.steamid);

        const data = await steamApiRequest<PlayerSummariesResponse>(
          'ISteamUser',
          'GetPlayerSummaries',
          'v2',
          { steamids: steamid },
        );

        const players = data.response?.players;
        if (!players || players.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No player found for Steam ID ${steamid}`,
              },
            ],
            isError: true,
          };
        }

        const player = players[0];

        const accountCreated = player.timecreated
          ? formatTimestamp(player.timecreated)
          : 'Unknown';

        const now = Date.now() / 1000;
        const accountAgeDays = player.timecreated
          ? Math.floor((now - player.timecreated) / 86400)
          : null;
        const accountAgeYears = accountAgeDays !== null
          ? (accountAgeDays / 365.25).toFixed(1)
          : null;

        const output: Record<string, unknown> = {
          steamid: player.steamid,
          personaName: player.personaname,
          profileUrl: player.profileurl,
          avatar: player.avatar,
          avatarFull: player.avatarfull,
          onlineStatus: PERSONA_STATES[player.personastate] ?? `Unknown (${player.personastate})`,
          lastLogoff: player.lastlogoff ? formatTimestamp(player.lastlogoff) : 'Unknown',
          accountCreated,
          accountAge: accountAgeYears !== null ? `${accountAgeYears} years (${accountAgeDays} days)` : 'Unknown',
        };

        if (player.gameextrainfo) {
          output.currentlyPlaying = player.gameextrainfo;
          output.currentGameId = player.gameid ?? null;
        }

        if (player.loccountrycode) {
          output.country = player.loccountrycode;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching player summary: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_player_level
  // -------------------------------------------------------------------------
  server.tool(
    'get_player_level',
    'Get a Steam player level, XP progress, and badge summary',
    {
      steamid: z.string().optional().describe('Steam ID 64 (defaults to current user)'),
    },
    async (params) => {
      try {
        const steamid = resolveDefaultSteamId(params.steamid);

        // Fetch level and badges in parallel
        const [levelData, badgesData] = await Promise.all([
          steamApiRequest<LevelResponse>(
            'IPlayerService',
            'GetSteamLevel',
            'v1',
            { steamid },
          ),
          steamApiRequest<BadgesResponse>(
            'IPlayerService',
            'GetBadges',
            'v1',
            { steamid },
          ),
        ]);

        const level = levelData.response?.player_level ?? 0;
        const badges = badgesData.response?.badges ?? [];
        const playerXp = badgesData.response?.player_xp ?? 0;
        const xpNeededCurrent = badgesData.response?.player_xp_needed_current_level ?? 0;
        const xpNeededNext = badgesData.response?.player_xp_needed_next_level ?? 0;

        const totalBadgeXp = badges.reduce((sum, b) => sum + (b.xp || 0), 0);
        const xpToNextLevel = xpNeededNext - playerXp;

        const output = {
          steamid,
          level,
          currentXp: playerXp,
          xpNeededForCurrentLevel: xpNeededCurrent,
          xpNeededForNextLevel: xpNeededNext,
          xpToNextLevel: xpToNextLevel > 0 ? xpToNextLevel : 0,
          xpProgress: xpNeededNext > xpNeededCurrent
            ? `${(((playerXp - xpNeededCurrent) / (xpNeededNext - xpNeededCurrent)) * 100).toFixed(1)}%`
            : '100%',
          badgeCount: badges.length,
          totalBadgeXp,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching player level: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_player_bans
  // -------------------------------------------------------------------------
  server.tool(
    'get_player_bans',
    'Check VAC bans, game bans, community bans, and trade ban status for a Steam player',
    {
      steamid: z.string().optional().describe('Steam ID 64 (defaults to current user)'),
    },
    async (params) => {
      try {
        const steamid = resolveDefaultSteamId(params.steamid);

        const data = await steamApiRequest<PlayerBansResponse>(
          'ISteamUser',
          'GetPlayerBans',
          'v1',
          { steamids: steamid },
        );

        const players = data.players;
        if (!players || players.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No ban data found for Steam ID ${steamid}`,
              },
            ],
            isError: true,
          };
        }

        const ban = players[0];

        const output = {
          steamid: ban.SteamId,
          communityBanned: ban.CommunityBanned,
          vacBanned: ban.VACBanned,
          numberOfVacBans: ban.NumberOfVACBans,
          daysSinceLastBan: ban.DaysSinceLastBan,
          numberOfGameBans: ban.NumberOfGameBans,
          economyBan: ban.EconomyBan,
          summary: ban.VACBanned || ban.CommunityBanned || ban.NumberOfGameBans > 0
            ? 'This account has bans on record.'
            : 'This account is in good standing.',
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching player bans: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
