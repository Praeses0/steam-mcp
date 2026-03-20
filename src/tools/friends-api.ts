import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Friend {
  steamid: string;
  relationship: string;
  friend_since: number;
}

interface FriendListResponse {
  friendslist: {
    friends: Friend[];
  };
}

interface PlayerSummary {
  steamid: string;
  personaname: string;
  personastate: number;
  gameextrainfo?: string;
  gameid?: string;
  avatar: string;
  profileurl: string;
  lastlogoff: number;
}

interface PlayerSummariesResponse {
  response: {
    players: PlayerSummary[];
  };
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

/**
 * Fetch player summaries in batches of up to 100 (Steam API limit).
 */
async function batchFetchSummaries(steamids: string[]): Promise<Map<string, PlayerSummary>> {
  const map = new Map<string, PlayerSummary>();
  const batchSize = 100;

  const batches: Promise<PlayerSummariesResponse>[] = [];
  for (let i = 0; i < steamids.length; i += batchSize) {
    const batch = steamids.slice(i, i + batchSize);
    batches.push(
      steamApiRequest<PlayerSummariesResponse>(
        'ISteamUser',
        'GetPlayerSummaries',
        'v2',
        { steamids: batch.join(',') },
      ),
    );
  }

  const results = await Promise.all(batches);
  for (const result of results) {
    const players = result.response?.players ?? [];
    for (const player of players) {
      map.set(player.steamid, player);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Sort priority: playing > online > offline
// ---------------------------------------------------------------------------

function sortPriority(summary: PlayerSummary | undefined): number {
  if (!summary) return 3;
  if (summary.gameextrainfo) return 0; // Currently playing
  if (summary.personastate >= 1) return 1; // Online (any non-offline state)
  return 2; // Offline
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFriendsApiTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_friend_list
  // -------------------------------------------------------------------------
  server.tool(
    'get_friend_list',
    'Fetch a Steam user\'s friend list with live online status and currently playing game info via the Steam Web API',
    {
      steamid: z.string().optional().describe('Steam ID 64 (defaults to current user)'),
    },
    async (params) => {
      try {
        const steamid = resolveDefaultSteamId(params.steamid);

        // Fetch the friend list
        const friendData = await steamApiRequest<FriendListResponse>(
          'ISteamUser',
          'GetFriendList',
          'v1',
          { steamid, relationship: 'friend' },
        );

        const friends = friendData.friendslist?.friends;
        if (!friends || friends.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No friends found for Steam ID ${steamid} (the profile may be private).`,
              },
            ],
          };
        }

        // Batch-fetch summaries for all friends
        const friendIds = friends.map((f) => f.steamid);
        const summaries = await batchFetchSummaries(friendIds);

        // Build enriched friend list
        const enriched = friends.map((f) => {
          const summary = summaries.get(f.steamid);

          const entry: Record<string, unknown> = {
            steamid: f.steamid,
            name: summary?.personaname ?? `Unknown (${f.steamid})`,
            onlineStatus: summary
              ? (PERSONA_STATES[summary.personastate] ?? `Unknown (${summary.personastate})`)
              : 'Unknown',
            friendSince: formatTimestamp(f.friend_since),
          };

          if (summary?.gameextrainfo) {
            entry.currentlyPlaying = summary.gameextrainfo;
            entry.currentGameId = summary.gameid ?? null;
          }

          if (summary?.profileurl) {
            entry.profileUrl = summary.profileurl;
          }

          return { entry, summary };
        });

        // Sort: currently playing first, then online, then offline
        enriched.sort((a, b) => {
          const pa = sortPriority(a.summary);
          const pb = sortPriority(b.summary);
          if (pa !== pb) return pa - pb;
          // Secondary sort by name
          const nameA = (a.entry.name as string).toLowerCase();
          const nameB = (b.entry.name as string).toLowerCase();
          return nameA.localeCompare(nameB);
        });

        const sortedEntries = enriched.map((e) => e.entry);

        // Count by status
        const playingCount = enriched.filter((e) => sortPriority(e.summary) === 0).length;
        const onlineCount = enriched.filter((e) => sortPriority(e.summary) === 1).length;
        const offlineCount = enriched.filter((e) => sortPriority(e.summary) >= 2).length;

        const output = {
          steamid,
          totalFriends: friends.length,
          currentlyPlaying: playingCount,
          online: onlineCount,
          offline: offlineCount,
          friends: sortedEntries,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching friend list: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
