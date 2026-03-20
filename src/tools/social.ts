import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLocalConfig } from '../steam/userdata.js';
import type { VdfObject } from '../vdf/types.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSocialTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_friend_activity
  // -------------------------------------------------------------------------
  server.tool(
    'get_friend_activity',
    'Parse the locally cached friends list from localconfig.vdf (no online status — local data only)',
    {},
    async () => {
      try {
        const config = getLocalConfig();

        // Navigate to UserLocalConfigStore > friends (case-insensitive)
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
          // Friend entries are keyed by numeric SteamID; skip non-numeric keys
          // like "PersonaName", "communitypreferences", "NameHistory", etc.
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
          count: friendList.length,
          note: 'This is locally cached data only — no online/offline status available.',
          friends: friendList,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error reading friends list: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
