import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { formatPlaytime, formatTimestamp } from '../util/format.js';
import { getUserDataDir } from '../steam/paths.js';

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
// Constants
// ---------------------------------------------------------------------------

const CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';

/** Known local grid image suffixes and their descriptions. */
const GRID_SUFFIXES: Array<{ suffix: string; label: string }> = [
  { suffix: '_hero.jpg', label: 'hero' },
  { suffix: '_hero.png', label: 'hero' },
  { suffix: 'p.jpg', label: 'portrait' },
  { suffix: 'p.png', label: 'portrait' },
  { suffix: '.jpg', label: 'grid' },
  { suffix: '.png', label: 'grid' },
  { suffix: '_logo.png', label: 'logo' },
  { suffix: '_logo.jpg', label: 'logo' },
  { suffix: '_icon.jpg', label: 'icon' },
  { suffix: '_icon.png', label: 'icon' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secondsToHours(seconds: number): string | null {
  if (!seconds || seconds <= 0) return null;
  return (seconds / 3600).toFixed(1);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleReviews(params: {
  appid?: number;
  count?: number;
  filter?: string;
}) {
  const appid = params.appid;
  if (!appid) {
    return {
      content: [{ type: 'text' as const, text: 'appid is required for reviews' }],
      isError: true,
    };
  }

  const filter = params.filter ?? 'all';
  const num_per_page = params.count ?? 10;

  const url =
    `https://store.steampowered.com/appreviews/${appid}?json=1` +
    `&filter=${filter}&language=english&num_per_page=${num_per_page}&purchase_type=all`;
  const response = await fetch(url);

  if (!response.ok) {
    return {
      content: [
        { type: 'text' as const, text: `Steam reviews API returned status ${response.status}` },
      ],
      isError: true,
    };
  }

  const data = (await response.json()) as ReviewsResponse;

  if (!data.success) {
    return {
      content: [
        { type: 'text' as const, text: `Failed to fetch reviews for appid ${appid}` },
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
}

async function handleNews(params: { appid?: number; count?: number }) {
  const appid = params.appid;
  if (!appid) {
    return {
      content: [{ type: 'text' as const, text: 'appid is required for news' }],
      isError: true,
    };
  }

  const count = params.count ?? 5;

  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${count}&maxlength=500`;
  const response = await fetch(url);

  if (!response.ok) {
    return {
      content: [
        { type: 'text' as const, text: `Steam news API returned status ${response.status}` },
      ],
      isError: true,
    };
  }

  const data = (await response.json()) as NewsResponse;

  if (!data.appnews || !data.appnews.newsitems || data.appnews.newsitems.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No news found for appid ${appid}` }],
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
}

async function handleMedia(params: { appid?: number }) {
  const appid = params.appid;
  if (!appid) {
    return {
      content: [{ type: 'text' as const, text: 'appid is required for media' }],
      isError: true,
    };
  }

  // Build CDN URLs
  const cdnUrls = {
    header: `${CDN_BASE}/${appid}/header.jpg`,
    capsule: `${CDN_BASE}/${appid}/capsule_616x353.jpg`,
    hero: `${CDN_BASE}/${appid}/hero_capsule.jpg`,
    libraryHero: `${CDN_BASE}/${appid}/library_hero.jpg`,
    logo: `${CDN_BASE}/${appid}/logo.png`,
  };

  // Check for local grid image overrides
  const localOverrides: Array<{ label: string; path: string }> = [];
  try {
    const userDataDir = getUserDataDir();
    const gridDir = path.join(userDataDir, 'config', 'grid');

    if (fs.existsSync(gridDir)) {
      for (const { suffix, label } of GRID_SUFFIXES) {
        const filePath = path.join(gridDir, `${appid}${suffix}`);
        if (fs.existsSync(filePath)) {
          localOverrides.push({ label, path: filePath });
        }
      }
    }
  } catch {
    // userdata may not be available
  }

  const output = {
    appid,
    cdn: cdnUrls,
    localOverrides: localOverrides.length > 0 ? localOverrides : null,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

async function handleHltb(params: { name?: string }) {
  const name = params.name;
  if (!name) {
    return {
      content: [{ type: 'text' as const, text: 'name is required for hltb' }],
      isError: true,
    };
  }

  const searchTerms = name
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
            `You can check manually at https://howlongtobeat.com/?q=${encodeURIComponent(name)}\n` +
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
          text: `No results found for "${name}" on HowLongToBeat.`,
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
    query: name,
    result_count: results.length,
    results,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

async function handlePcgamingwiki(params: { appid?: number; name?: string }) {
  if (!params.appid && !params.name) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Please provide either an appid or a game name to search.',
        },
      ],
      isError: true,
    };
  }

  let pageName: string | null = null;

  // Step 1: Find the wiki page
  if (params.appid) {
    // Search by Steam AppID using the Cargo API
    const cargoUrl =
      `https://www.pcgamingwiki.com/w/api.php?action=cargoquery` +
      `&tables=Infobox_game` +
      `&fields=Infobox_game._pageName=Page,Infobox_game.Steam_AppID` +
      `&where=Infobox_game.Steam_AppID=${params.appid}` +
      `&format=json`;

    const cargoResp = await fetch(cargoUrl);
    if (!cargoResp.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `PCGamingWiki API returned status ${cargoResp.status} when searching by appid.`,
          },
        ],
        isError: true,
      };
    }

    const cargoData = (await cargoResp.json()) as {
      cargoquery?: Array<{ title: { Page: string; 'Steam AppID': string } }>;
    };

    if (cargoData.cargoquery && cargoData.cargoquery.length > 0) {
      pageName = cargoData.cargoquery[0].title.Page;
    }
  }

  if (!pageName && params.name) {
    // Search by name using opensearch
    const searchUrl =
      `https://www.pcgamingwiki.com/w/api.php?action=opensearch` +
      `&search=${encodeURIComponent(params.name)}` +
      `&limit=5&format=json`;

    const searchResp = await fetch(searchUrl);
    if (!searchResp.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `PCGamingWiki API returned status ${searchResp.status} when searching by name.`,
          },
        ],
        isError: true,
      };
    }

    // OpenSearch returns: [query, [titles], [descriptions], [urls]]
    const searchData = (await searchResp.json()) as [string, string[], string[], string[]];
    const titles = searchData[1];

    if (titles && titles.length > 0) {
      pageName = titles[0];
    }
  }

  if (!pageName) {
    return {
      content: [
        {
          type: 'text' as const,
          text: params.appid
            ? `No PCGamingWiki article found for appid ${params.appid}.`
            : `No PCGamingWiki article found for "${params.name}".`,
        },
      ],
    };
  }

  // Step 2: Get the intro text
  let introText = '';
  try {
    const extractUrl =
      `https://www.pcgamingwiki.com/w/api.php?action=query` +
      `&titles=${encodeURIComponent(pageName)}` +
      `&prop=extracts&exintro=true&explaintext=true&format=json`;

    const extractResp = await fetch(extractUrl);
    if (extractResp.ok) {
      const extractData = (await extractResp.json()) as {
        query?: { pages?: Record<string, { extract?: string }> };
      };
      const pages = extractData.query?.pages;
      if (pages) {
        const pageObj = Object.values(pages)[0];
        if (pageObj?.extract) {
          introText = pageObj.extract;
        }
      }
    }
  } catch {
    // Intro extraction failed, continue without it
  }

  // Step 3: Get the article sections
  let sections: Array<{ index: string; line: string; level: string }> = [];
  try {
    const sectionsUrl =
      `https://www.pcgamingwiki.com/w/api.php?action=parse` +
      `&page=${encodeURIComponent(pageName)}` +
      `&prop=sections&format=json`;

    const sectionsResp = await fetch(sectionsUrl);
    if (sectionsResp.ok) {
      const sectionsData = (await sectionsResp.json()) as {
        parse?: {
          sections?: Array<{ index: string; line: string; level: string }>;
        };
      };
      if (sectionsData.parse?.sections) {
        sections = sectionsData.parse.sections;
      }
    }
  } catch {
    // Sections fetch failed, continue without them
  }

  const wikiUrl = `https://www.pcgamingwiki.com/wiki/${encodeURIComponent(pageName.replace(/ /g, '_'))}`;

  const output = {
    gameName: pageName,
    pcgamingwiki_url: wikiUrl,
    intro: introText || '(no intro text available)',
    sections: sections.map((s) => ({
      index: s.index,
      title: s.line,
      level: parseInt(s.level, 10),
    })),
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGameInfoTools(server: McpServer): void {
  server.tool(
    'game_info',
    'Reviews, news, media, HLTB times, PCGamingWiki fixes',
    {
      action: z.enum(['reviews', 'news', 'media', 'hltb', 'pcgamingwiki']),
      appid: z.number().optional(),
      name: z.string().optional(),
      count: z.number().optional(),
      filter: z.enum(['recent', 'updated', 'all']).optional(),
    },
    async (params) => {
      try {
        switch (params.action) {
          case 'reviews':
            return await handleReviews(params);
          case 'news':
            return await handleNews(params);
          case 'media':
            return await handleMedia(params);
          case 'hltb':
            return await handleHltb(params);
          case 'pcgamingwiki':
            return await handlePcgamingwiki(params);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error in game_info/${params.action}: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
