import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserConfig } from '../steam/paths.js';
import { fetchAllWishlistPages } from '../steam/wishlist.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWishlistTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_wishlist
  // -------------------------------------------------------------------------
  server.tool(
    'get_wishlist',
    'Fetch a Steam user\'s wishlist with game names, priorities, reviews, and pricing info',
    {
      steamid: z
        .string()
        .optional()
        .describe('Steam ID 64 of the user (defaults to the current logged-in user)'),
    },
    async (params) => {
      try {
        let steamid = params.steamid;

        if (!steamid) {
          const userConfig = getUserConfig();
          steamid = userConfig.steamId64;
        }

        const allItems = await fetchAllWishlistPages(steamid);

        if (allItems.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No wishlist data found for Steam ID ${steamid}. The wishlist may be private or empty.`,
              },
            ],
          };
        }

        // Build items array and sort by priority (lower = higher priority), then name
        const items = allItems
          .map((item) => {
            // Determine price info
            let priceInfo: string | { price: string; discount_pct: number } = 'N/A';
            if (item.free || item.is_free_game) {
              priceInfo = 'Free';
            } else if (item.subs && item.subs.length > 0) {
              const sub = item.subs[0];
              priceInfo = {
                price: sub.price || 'N/A',
                discount_pct: sub.discount_pct || 0,
              };
            }

            return {
              appid: item.appid,
              name: item.name,
              priority: item.priority,
              review_desc: item.review_desc,
              release_date: item.release_string,
              free: item.free || item.is_free_game,
              price: priceInfo,
              type: item.type,
            };
          })
          .sort((a, b) => {
            // Priority 0 means "not prioritized" — push to end
            const aPri = a.priority === 0 ? Number.MAX_SAFE_INTEGER : a.priority;
            const bPri = b.priority === 0 ? Number.MAX_SAFE_INTEGER : b.priority;
            if (aPri !== bPri) return aPri - bPri;
            return a.name.localeCompare(b.name);
          });

        const output = {
          steamid,
          total_count: items.length,
          items,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching wishlist: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
