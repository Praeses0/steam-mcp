import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NewsItem {
  gid: string;
  title: string;
  url: string;
  is_external_url: boolean;
  author: string;
  contents: string;
  feedlabel: string;
  date: number;
  feedname: string;
  feed_type: number;
  appid: number;
}

interface NewsResponse {
  appnews?: {
    appid: number;
    newsitems: NewsItem[];
    count: number;
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerNewsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_news
  // -------------------------------------------------------------------------
  server.tool(
    'get_news',
    'Fetch recent news articles for a Steam game from the Steam news API',
    {
      appid: z.number().describe('Steam application ID'),
      count: z.number().default(5).describe('Number of news items to fetch (default 5)'),
    },
    async (params) => {
      try {
        const { appid, count } = params;

        const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${count}&maxlength=500`;
        const response = await fetch(url);

        if (!response.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Steam news API returned status ${response.status}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as NewsResponse;

        if (!data.appnews || !data.appnews.newsitems || data.appnews.newsitems.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No news found for appid ${appid}`,
              },
            ],
          };
        }

        const items = data.appnews.newsitems.map((item) => ({
          title: item.title,
          date: formatTimestamp(item.date),
          author: item.author || 'Unknown',
          url: item.url,
          feedLabel: item.feedlabel,
          contents: item.contents,
        }));

        const output = {
          appid,
          count: items.length,
          news: items,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching news: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
