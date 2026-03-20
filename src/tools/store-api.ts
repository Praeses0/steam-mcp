import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatPlaytime, formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppDetailsData {
  type: string;
  name: string;
  steam_appid: number;
  required_age: number;
  is_free: boolean;
  detailed_description: string;
  about_the_game: string;
  short_description: string;
  supported_languages: string;
  header_image: string;
  website: string | null;
  pc_requirements: { minimum?: string; recommended?: string };
  developers: string[];
  publishers: string[];
  price_overview?: {
    currency: string;
    initial: number;
    final: number;
    discount_percent: number;
    final_formatted: string;
  };
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  metacritic?: { score: number; url: string };
  categories: Array<{ id: number; description: string }>;
  genres: Array<{ id: string; description: string }>;
  release_date: { coming_soon: boolean; date: string };
  content_descriptors: unknown;
}

interface AppDetailsResponse {
  [appid: string]: {
    success: boolean;
    data: AppDetailsData;
  };
}

interface ReviewAuthor {
  steamid: string;
  num_games_owned: number;
  num_reviews: number;
  playtime_forever: number;
  playtime_at_review: number;
}

interface Review {
  recommendationid: string;
  author: ReviewAuthor;
  language: string;
  review: string;
  timestamp_created: number;
  voted_up: boolean;
  votes_up: number;
  votes_funny: number;
  comment_count: number;
  steam_purchase: boolean;
  received_for_free: boolean;
  written_during_early_access: boolean;
}

interface ReviewsResponse {
  success: number;
  query_summary: {
    num_reviews: number;
    review_score: number;
    review_score_desc: string;
    total_positive: number;
    total_negative: number;
    total_reviews: number;
  };
  reviews: Review[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStoreApiTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_game_details
  // -------------------------------------------------------------------------
  server.tool(
    'get_game_details',
    'Fetch detailed information about a Steam game from the store API (description, price, platforms, metacritic, etc.)',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const { appid } = params;

        const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
        const response = await fetch(url);

        if (!response.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Steam store API returned status ${response.status}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as AppDetailsResponse;
        const entry = data[String(appid)];

        if (!entry || !entry.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No details found for appid ${appid}. The app may not exist or the store page may be restricted.`,
              },
            ],
            isError: true,
          };
        }

        const d = entry.data;

        const summary = {
          name: d.name,
          type: d.type,
          steam_appid: d.steam_appid,
          is_free: d.is_free,
          short_description: stripHtml(d.short_description || ''),
          developers: d.developers || [],
          publishers: d.publishers || [],
          genres: (d.genres || []).map((g) => g.description),
          categories: (d.categories || []).map((c) => c.description),
          release_date: d.release_date,
          platforms: d.platforms,
          linux_support: d.platforms?.linux ?? false,
          price: d.price_overview
            ? {
                final_formatted: d.price_overview.final_formatted,
                discount_percent: d.price_overview.discount_percent,
                currency: d.price_overview.currency,
              }
            : d.is_free
              ? 'Free'
              : 'N/A',
          metacritic: d.metacritic
            ? { score: d.metacritic.score, url: d.metacritic.url }
            : null,
          header_image: d.header_image,
          website: d.website,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching game details: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_game_reviews
  // -------------------------------------------------------------------------
  server.tool(
    'get_game_reviews',
    'Fetch user reviews for a Steam game, including review summary and individual review texts',
    {
      appid: z.number().describe('Steam application ID'),
      filter: z
        .enum(['recent', 'updated', 'all'])
        .default('all')
        .describe('Review filter: recent, updated, or all (default all)'),
      num_per_page: z
        .number()
        .default(10)
        .describe('Number of reviews to fetch per page (default 10)'),
    },
    async (params) => {
      try {
        const { appid, filter, num_per_page } = params;

        const url =
          `https://store.steampowered.com/appreviews/${appid}?json=1` +
          `&filter=${filter}&language=english&num_per_page=${num_per_page}&purchase_type=all`;
        const response = await fetch(url);

        if (!response.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Steam reviews API returned status ${response.status}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as ReviewsResponse;

        if (!data.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to fetch reviews for appid ${appid}`,
              },
            ],
            isError: true,
          };
        }

        const summary = {
          review_score_desc: data.query_summary.review_score_desc,
          total_positive: data.query_summary.total_positive,
          total_negative: data.query_summary.total_negative,
          total_reviews: data.query_summary.total_reviews,
        };

        const reviews = (data.reviews || []).map((r) => ({
          voted_up: r.voted_up,
          review: r.review.length > 500 ? r.review.slice(0, 500) + '...' : r.review,
          playtime_at_review: formatPlaytime(Math.round(r.author.playtime_at_review / 60)),
          timestamp: formatTimestamp(r.timestamp_created),
          votes_up: r.votes_up,
          votes_funny: r.votes_funny,
          steam_purchase: r.steam_purchase,
          written_during_early_access: r.written_during_early_access,
        }));

        const output = {
          appid,
          summary,
          reviews_returned: reviews.length,
          reviews,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching reviews: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
