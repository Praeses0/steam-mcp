import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { formatPlaytime } from '../util/format.js';
import type { OwnedGamesResponse } from '../steam/api-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export function registerValuationTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // library_value
  // -------------------------------------------------------------------------
  server.tool(
    'library_value',
    'Estimate the total value of a Steam library by store prices',
    {
      steamid: z
        .string()
        .optional()
        .describe('SteamID64 of the user (defaults to current user)'),
      sample_size: z
        .number()
        .default(100)
        .describe(
          'Number of games to price check, sorted by playtime descending (default 100). Checking all games would be slow.',
        ),
    },
    async (params) => {
      try {
        const steamid = params.steamid ?? getUserConfig().steamId64;
        const sampleSize = params.sample_size;

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
    },
  );
}
