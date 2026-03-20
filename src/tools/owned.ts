import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { formatPlaytime } from '../util/format.js';
import type { OwnedGamesResponse } from '../steam/api-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecentGame {
  appid: number;
  name: string;
  playtime_2weeks: number;
  playtime_forever: number;
  img_icon_url: string;
}

interface RecentlyPlayedResponse {
  response: {
    total_count: number;
    games: RecentGame[];
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerOwnedTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_owned_games
  // -------------------------------------------------------------------------
  server.tool(
    'get_owned_games',
    'Get owned games with sorting, searching, and pagination',
    {
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the user (defaults to current user)'),
      sort_by: z
        .enum(['playtime', 'name', 'recent'])
        .default('playtime')
        .describe('Sort field (default: playtime)'),
      sort_order: z
        .enum(['asc', 'desc'])
        .default('desc')
        .describe('Sort order (default: desc)'),
      limit: z.number().default(50).describe('Max results to return (default 50)'),
      offset: z.number().default(0).describe('Number of results to skip (default 0)'),
      search: z
        .string()
        .optional()
        .describe('Filter games by name (case-insensitive substring match)'),
    },
    async (params) => {
      try {
        const steamid = params.steamid ?? getUserConfig().steamId64;

        const data = await steamApiRequest<OwnedGamesResponse>(
          'IPlayerService',
          'GetOwnedGames',
          'v1',
          {
            steamid,
            include_appinfo: 1,
            include_played_free_games: 1,
          },
        );

        let games = data.response.games ?? [];
        const totalOwned = data.response.game_count;

        // Filter by search term
        if (params.search) {
          const needle = params.search.toLowerCase();
          games = games.filter((g) => g.name.toLowerCase().includes(needle));
        }

        // Sort
        const dir = params.sort_order === 'asc' ? 1 : -1;
        switch (params.sort_by) {
          case 'playtime':
            games.sort((a, b) => dir * (a.playtime_forever - b.playtime_forever));
            break;
          case 'name':
            games.sort((a, b) => dir * a.name.localeCompare(b.name));
            break;
          case 'recent':
            games.sort(
              (a, b) => dir * ((a.playtime_2weeks ?? 0) - (b.playtime_2weeks ?? 0)),
            );
            break;
        }

        // Paginate
        const paginated = games.slice(params.offset, params.offset + params.limit);

        const output = {
          game_count: totalOwned,
          showing: paginated.length,
          games: paginated.map((g) => ({
            appid: g.appid,
            name: g.name,
            playtime: formatPlaytime(g.playtime_forever),
            ...(g.playtime_2weeks && g.playtime_2weeks > 0
              ? { playtime_2weeks: formatPlaytime(g.playtime_2weeks) }
              : {}),
            icon_url: `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`,
          })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching owned games: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_recently_played
  // -------------------------------------------------------------------------
  server.tool(
    'get_recently_played',
    'Get recently played games from the last two weeks',
    {
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the user (defaults to current user)'),
      count: z.number().default(10).describe('Number of games to return (default 10)'),
    },
    async (params) => {
      try {
        const steamid = params.steamid ?? getUserConfig().steamId64;

        const data = await steamApiRequest<RecentlyPlayedResponse>(
          'IPlayerService',
          'GetRecentlyPlayedGames',
          'v1',
          {
            steamid,
            count: params.count,
          },
        );

        const output = {
          total_count: data.response.total_count,
          games: (data.response.games ?? []).map((g) => ({
            appid: g.appid,
            name: g.name,
            playtime_2weeks: formatPlaytime(g.playtime_2weeks),
            playtime_forever: formatPlaytime(g.playtime_forever),
          })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error fetching recently played games: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
