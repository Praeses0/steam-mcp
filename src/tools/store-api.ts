import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatPlaytime, formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Registration
// ---------------------------------------------------------------------------

export function registerStoreApiTools(server: McpServer): void {
  // get_game_details has been merged into get_game (games.ts) via include_store_details parameter

  // -------------------------------------------------------------------------
  // get_game_reviews
  // -------------------------------------------------------------------------
  server.tool(
    'get_game_reviews',
    'Fetch user reviews and review summary for a game',
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
          playtime_at_review: formatPlaytime(r.author.playtime_at_review),
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
