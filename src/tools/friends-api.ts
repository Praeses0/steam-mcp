import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hasApiKey, steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { getLocalConfig } from '../steam/userdata.js';
import { formatTimestamp } from '../util/format.js';
import { PERSONA_STATES } from '../steam/api-types.js';
import type { PlayerSummary, PlayerSummariesResponse } from '../steam/api-types.js';
import type { VdfObject } from '../vdf/types.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    'Fetch friend list with online status and currently playing info',
    {
      steamid: z.string().optional().describe('Steam ID 64 (defaults to current user)'),
    },
    async (params) => {
      try {
        // ---- API path (when key is available) ----
        if (hasApiKey()) {
          const steamid = resolveDefaultSteamId(params.steamid);

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
            const nameA = (a.entry.name as string).toLowerCase();
            const nameB = (b.entry.name as string).toLowerCase();
            return nameA.localeCompare(nameB);
          });

          const sortedEntries = enriched.map((e) => e.entry);

          const playingCount = enriched.filter((e) => sortPriority(e.summary) === 0).length;
          const onlineCount = enriched.filter((e) => sortPriority(e.summary) === 1).length;
          const offlineCount = enriched.filter((e) => sortPriority(e.summary) >= 2).length;

          const output = {
            source: 'api' as const,
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
        }

        // ---- Local fallback (no API key) ----
        const config = getLocalConfig();

        const root = config['UserLocalConfigStore'] ?? config['userlocalconfigstore'];
        if (!root || typeof root === 'string') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Could not find UserLocalConfigStore in localconfig.vdf',
              },
            ],
            isError: true,
          };
        }

        const rootObj = root as VdfObject;
        const friends = rootObj['friends'] ?? rootObj['Friends'];

        if (!friends || typeof friends === 'string') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No friends section found in localconfig.vdf. Friends data may not be cached locally.',
              },
            ],
          };
        }

        const friendsObj = friends as VdfObject;
        const friendList: Array<{ steamId: string; name: string }> = [];

        for (const [key, value] of Object.entries(friendsObj)) {
          if (!/^\d+$/.test(key)) continue;

          if (typeof value === 'object') {
            const friendObj = value as VdfObject;
            const name = (friendObj['name'] ?? friendObj['Name'] ?? '') as string;
            friendList.push({
              steamId: key,
              name: name || `Unknown (${key})`,
            });
          }
        }

        const output = {
          source: 'local' as const,
          count: friendList.length,
          note: 'This is locally cached data only — online/offline status is not available without a Steam API key. Set the STEAM_API_KEY environment variable for live status.',
          friends: friendList,
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
