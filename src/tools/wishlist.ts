import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserConfig } from '../steam/paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WishlistItem {
  name: string;
  capsule: string;
  review_score: number;
  review_desc: string;
  reviews_total: string;
  reviews_percent: number;
  release_string: string;
  release_date: number;
  priority: number;
  added: number;
  type: string;
  free: boolean;
  is_free_game: boolean;
  subs: Array<{
    id: number;
    discount_block: string;
    discount_pct: number;
    price: string;
  }>;
}

interface WishlistResponse {
  [appid: string]: WishlistItem;
}

interface WishlistErrorResponse {
  success: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a single wishlist page. Returns null if the page is empty or an error. */
async function fetchWishlistPage(
  steamid: string,
  page: number,
): Promise<WishlistResponse | null> {
  const url = `https://store.steampowered.com/wishlist/profiles/${steamid}/wishlistdata/?p=${page}`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as WishlistResponse | WishlistErrorResponse;

  // Steam returns { success: 2 } when the wishlist is private or no more pages
  if ('success' in data && (data as WishlistErrorResponse).success === 2) {
    return null;
  }

  // Empty object means no more pages
  if (Object.keys(data).length === 0) {
    return null;
  }

  return data as WishlistResponse;
}

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

        // Fetch first 3 pages in parallel (covers up to ~300 items)
        const pages = await Promise.all([
          fetchWishlistPage(steamid, 0),
          fetchWishlistPage(steamid, 1),
          fetchWishlistPage(steamid, 2),
        ]);

        // Merge all pages into a single map
        const allItems: Record<string, WishlistItem> = {};
        for (const page of pages) {
          if (page) {
            Object.assign(allItems, page);
          }
        }

        if (Object.keys(allItems).length === 0) {
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
        const items = Object.entries(allItems)
          .map(([appid, item]) => {
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
              appid: Number(appid),
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
