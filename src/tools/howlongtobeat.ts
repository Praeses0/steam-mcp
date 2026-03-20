import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HltbGame {
  game_id: number;
  game_name: string;
  game_image: string;
  comp_main: number;
  comp_plus: number;
  comp_100: number;
  comp_all: number;
}

interface HltbSearchResponse {
  data: HltbGame[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secondsToHours(seconds: number): string | null {
  if (!seconds || seconds <= 0) return null;
  return (seconds / 3600).toFixed(1);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHowLongToBeatTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // howlongtobeat
  // -------------------------------------------------------------------------
  server.tool(
    'howlongtobeat',
    'Search HowLongToBeat for estimated completion times',
    {
      name: z.string().describe('Game name to search for'),
    },
    async (params) => {
      try {
        const searchTerms = params.name
          .trim()
          .split(/\s+/)
          .filter((t) => t.length > 0);

        const body = {
          searchType: 'games',
          searchTerms,
          searchPage: 1,
          size: 5,
          searchOptions: {
            games: {
              userId: 0,
              platform: '',
              sortCategory: 'popular',
              rangeCategory: 'main',
              rangeTime: { min: null, max: null },
              gameplay: {
                perspective: '',
                flow: '',
                genre: '',
                subGenre: '',
              },
              rangeYear: { min: '', max: '' },
              modifier: '',
            },
            users: { sortCategory: 'postcount' },
            lists: { sortCategory: 'follows' },
            filter: '',
            sort: 0,
            randomizer: 0,
          },
        };

        const response = await fetch('https://howlongtobeat.com/api/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://howlongtobeat.com',
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          return {
            content: [
              {
                type: 'text' as const,
                text: `HowLongToBeat API returned HTTP ${response.status}. ` +
                  `The API may have changed or be temporarily unavailable. ` +
                  `You can check manually at https://howlongtobeat.com/?q=${encodeURIComponent(params.name)}\n` +
                  (errorText ? `Response: ${errorText.slice(0, 200)}` : ''),
              },
            ],
            isError: true,
          };
        }

        const data: HltbSearchResponse = await response.json();
        const games = data.data ?? [];

        if (games.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No results found for "${params.name}" on HowLongToBeat.`,
              },
            ],
          };
        }

        const results = games.slice(0, 5).map((game) => ({
          name: game.game_name,
          hltb_id: game.game_id,
          main_story_hours: secondsToHours(game.comp_main),
          main_plus_extras_hours: secondsToHours(game.comp_plus),
          completionist_hours: secondsToHours(game.comp_100),
          all_styles_hours: secondsToHours(game.comp_all),
          image_url: game.game_image
            ? `https://howlongtobeat.com/games/${game.game_image}`
            : null,
          hltb_url: `https://howlongtobeat.com/game/${game.game_id}`,
        }));

        const output = {
          query: params.name,
          result_count: results.length,
          results,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching HowLongToBeat: ${msg}. ` +
                `You can check manually at https://howlongtobeat.com/?q=${encodeURIComponent(params.name)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
