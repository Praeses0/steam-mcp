import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserConfig } from '../steam/paths.js';
import { fetchAllWishlistPages } from '../steam/wishlist.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoreSearchItem {
  id: number;
  name: string;
  type: string;
}

interface StoreSearchResponse {
  total: number;
  items: StoreSearchItem[];
}

interface PriceOverview {
  currency: string;
  initial: number;
  final: number;
  discount_percent: number;
  initial_formatted: string;
  final_formatted: string;
}

interface AppDetailsPriceResponse {
  [appid: string]: {
    success: boolean;
    data: {
      price_overview?: PriceOverview;
    };
  };
}

interface AppDetailsBasicResponse {
  [appid: string]: {
    success: boolean;
    data: {
      name: string;
      steam_appid: number;
      is_free: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Search the Steam store by name and return the first matching appid. */
async function searchStoreByName(name: string): Promise<StoreSearchItem | null> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=US`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as StoreSearchResponse;

  if (!data.items || data.items.length === 0) {
    return null;
  }

  return data.items[0];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDealsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // check_sale
  // -------------------------------------------------------------------------
  server.tool(
    'check_sale',
    'Check if a game is currently on sale',
    {
      appid: z
        .number()
        .optional()
        .describe('Steam application ID (if known)'),
      name: z
        .string()
        .optional()
        .describe('Game name to search for (used if appid is not provided)'),
    },
    async (params) => {
      try {
        let appid = params.appid;
        let gameName: string | undefined;

        // If no appid provided, search by name
        if (appid === undefined) {
          if (!params.name) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Please provide either an appid or a game name to search for.',
                },
              ],
              isError: true,
            };
          }

          const searchResult = await searchStoreByName(params.name);

          if (!searchResult) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No games found matching "${params.name}" on the Steam store.`,
                },
              ],
              isError: true,
            };
          }

          appid = searchResult.id;
          gameName = searchResult.name;
        }

        // Fetch price overview and basic details in parallel
        const [priceResponse, basicResponse] = await Promise.all([
          fetch(
            `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=price_overview`,
          ),
          fetch(
            `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`,
          ),
        ]);

        if (!priceResponse.ok || !basicResponse.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Steam store API returned an error (price: ${priceResponse.status}, basic: ${basicResponse.status})`,
              },
            ],
            isError: true,
          };
        }

        const priceData = (await priceResponse.json()) as AppDetailsPriceResponse;
        const basicData = (await basicResponse.json()) as AppDetailsBasicResponse;

        const priceEntry = priceData[String(appid)];
        const basicEntry = basicData[String(appid)];

        // Get the game name from basic details if we don't have it yet
        if (!gameName && basicEntry?.success) {
          gameName = basicEntry.data.name;
        }

        if (!priceEntry || !priceEntry.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Could not fetch price data for appid ${appid}. The app may not exist or the store page may be restricted.`,
              },
            ],
            isError: true,
          };
        }

        const priceOverview = priceEntry.data.price_overview;
        const isFree = basicEntry?.success && basicEntry.data.is_free;

        if (!priceOverview) {
          const output = {
            name: gameName ?? `App ${appid}`,
            appid,
            on_sale: false,
            note: isFree
              ? 'This game is free to play.'
              : 'No pricing information available. The game may be free, delisted, or not sold individually.',
          };

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // Prices from the API are in cents
        const originalPrice = (priceOverview.initial / 100).toFixed(2);
        const currentPrice = (priceOverview.final / 100).toFixed(2);
        const savings = ((priceOverview.initial - priceOverview.final) / 100).toFixed(2);

        const output = {
          name: gameName ?? `App ${appid}`,
          appid,
          on_sale: priceOverview.discount_percent > 0,
          discount_percent: priceOverview.discount_percent,
          original_price: `${originalPrice} ${priceOverview.currency}`,
          current_price: `${currentPrice} ${priceOverview.currency}`,
          savings: priceOverview.discount_percent > 0
            ? `${savings} ${priceOverview.currency}`
            : '0.00',
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error checking sale: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // wishlist_deals
  // -------------------------------------------------------------------------
  server.tool(
    'wishlist_deals',
    'Find discounted games on a user\'s wishlist',
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

        const totalItems = allItems.length;

        if (totalItems === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No wishlist data found for Steam ID ${steamid}. The wishlist may be private or empty.`,
              },
            ],
          };
        }

        // Filter to items that have a discount
        const deals = allItems
          .filter((item) => {
            if (item.free || item.is_free_game) return false;
            return item.subs && item.subs.some((sub) => sub.discount_pct > 0);
          })
          .map((item) => {
            // Find the sub with the best discount
            const bestSub = item.subs
              .filter((sub) => sub.discount_pct > 0)
              .sort((a, b) => b.discount_pct - a.discount_pct)[0];

            return {
              appid: item.appid,
              name: item.name,
              discount_percent: bestSub.discount_pct,
              price: bestSub.price,
              review_desc: item.review_desc,
            };
          })
          .sort((a, b) => b.discount_percent - a.discount_percent);

        const output = {
          steamid,
          total_wishlist_items: totalItems,
          deals_found: deals.length,
          deals,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching wishlist deals: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
