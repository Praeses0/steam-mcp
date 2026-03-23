import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import type { OwnedGamesResponse } from '../steam/api-types.js';
import { getUserConfig } from '../steam/paths.js';
import { fetchAllWishlistPages } from '../steam/wishlist.js';
import { formatPlaytime } from '../util/format.js';

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

/** Fetch price data for a single appid. Returns null if unavailable. */
async function fetchAppPrice(
  appid: number,
): Promise<{ appid: number; initial: number; final: number; currency: string } | null> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=price_overview`,
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as AppDetailsPriceResponse;
    const entry = data[String(appid)];

    if (!entry || !entry.success || !entry.data.price_overview) {
      return null;
    }

    return {
      appid,
      initial: entry.data.price_overview.initial,
      final: entry.data.price_overview.final,
      currency: entry.data.price_overview.currency,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch prices for a batch of appids in parallel using Promise.allSettled.
 */
async function fetchPriceBatch(
  appids: number[],
): Promise<Array<{ appid: number; initial: number; final: number; currency: string } | null>> {
  const results = await Promise.allSettled(appids.map((id) => fetchAppPrice(id)));
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDealsTools(server: McpServer): void {
  server.tool(
    'deals',
    'Sale checks, wishlist, deals, library value',
    {
      action: z.enum(['check_sale', 'wishlist_deals', 'wishlist', 'library_value']),
      appid: z.number().optional(),
      name: z.string().optional(),
      steamid: z.string().optional(),
    },
    async (params) => {
      switch (params.action) {
        // -------------------------------------------------------------------
        // check_sale
        // -------------------------------------------------------------------
        case 'check_sale': {
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
        }

        // -------------------------------------------------------------------
        // wishlist_deals
        // -------------------------------------------------------------------
        case 'wishlist_deals': {
          try {
            const steamid = params.steamid ?? getUserConfig().steamId64;

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
        }

        // -------------------------------------------------------------------
        // wishlist
        // -------------------------------------------------------------------
        case 'wishlist': {
          try {
            const steamid = params.steamid ?? getUserConfig().steamId64;

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
        }

        // -------------------------------------------------------------------
        // library_value
        // -------------------------------------------------------------------
        case 'library_value': {
          try {
            const steamid = params.steamid ?? getUserConfig().steamId64;
            const sampleSize = 100;

            // Fetch owned games
            const ownedData = await steamApiRequest<OwnedGamesResponse>(
              'IPlayerService',
              'GetOwnedGames',
              'v1',
              {
                steamid,
                include_appinfo: 1,
                include_played_free_games: 1,
              },
            );

            const allGames = ownedData.response.games ?? [];
            const totalOwned = ownedData.response.game_count;

            if (allGames.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No games found for Steam ID ${steamid}. The profile may be private.`,
                  },
                ],
              };
            }

            // Sort by playtime descending and take the sample
            const sorted = [...allGames].sort(
              (a, b) => b.playtime_forever - a.playtime_forever,
            );
            const sample = sorted.slice(0, sampleSize);

            // Batch fetch prices in groups of 20
            const batchSize = 20;
            const priceResults: Array<{
              appid: number;
              initial: number;
              final: number;
              currency: string;
            } | null> = [];

            for (let i = 0; i < sample.length; i += batchSize) {
              const batch = sample.slice(i, i + batchSize).map((g) => g.appid);
              const batchResults = await fetchPriceBatch(batch);
              priceResults.push(...batchResults);
            }

            // Aggregate results
            let totalInitial = 0;
            let totalFinal = 0;
            let gamesWithPrice = 0;
            let totalPlaytimeMinutes = 0;
            let currency = 'USD';

            const pricedGames: Array<{
              appid: number;
              name: string;
              playtime: string;
              original_price: string;
              current_price: string;
            }> = [];

            for (let i = 0; i < sample.length; i++) {
              const game = sample[i];
              const price = priceResults[i];
              totalPlaytimeMinutes += game.playtime_forever;

              if (price) {
                gamesWithPrice++;
                totalInitial += price.initial;
                totalFinal += price.final;
                currency = price.currency;

                pricedGames.push({
                  appid: game.appid,
                  name: game.name,
                  playtime: formatPlaytime(game.playtime_forever),
                  original_price: `${(price.initial / 100).toFixed(2)} ${price.currency}`,
                  current_price: `${(price.final / 100).toFixed(2)} ${price.currency}`,
                });
              }
            }

            // Also sum total playtime across ALL owned games
            const allPlaytimeMinutes = allGames.reduce(
              (sum, g) => sum + g.playtime_forever,
              0,
            );

            const estimatedValue = (totalInitial / 100).toFixed(2);
            const currentStoreValue = (totalFinal / 100).toFixed(2);
            const costPerHour =
              allPlaytimeMinutes > 0
                ? ((totalInitial / 100) / (allPlaytimeMinutes / 60)).toFixed(2)
                : 'N/A';

            const output = {
              steamid,
              total_games_owned: totalOwned,
              games_checked: sample.length,
              games_with_price: gamesWithPrice,
              games_free_or_delisted: sample.length - gamesWithPrice,
              estimated_value: `${estimatedValue} ${currency}`,
              current_store_value: `${currentStoreValue} ${currency}`,
              total_playtime: formatPlaytime(allPlaytimeMinutes),
              cost_per_hour_estimate: costPerHour !== 'N/A'
                ? `${costPerHour} ${currency}/hr`
                : 'N/A',
              note:
                sample.length < totalOwned
                  ? `Only checked top ${sample.length} games by playtime out of ${totalOwned} total. Actual library value is likely higher.`
                  : 'Checked all owned games.',
              top_valued_games: pricedGames
                .sort(
                  (a, b) =>
                    parseFloat(b.original_price) - parseFloat(a.original_price),
                )
                .slice(0, 20),
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error estimating library value: ${msg}` },
              ],
              isError: true,
            };
          }
        }
      }
    },
  );
}
