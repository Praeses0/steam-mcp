import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readAllManifests } from '../steam/manifests.js';
import { getPlaytime, getAllPlaytimes, getAppLaunchOptions } from '../steam/userdata.js';
import { getGameProtonVersion, getCompatDataSize } from '../steam/compat.js';
import { readWorkshopManifest } from '../steam/workshop.js';
import { formatBytes, formatPlaytime, formatTimestamp } from '../util/format.js';
import type { AppManifest } from '../steam/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROMAN_MAP: Record<string, string> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
};

function scoreSearch(query: string, manifest: AppManifest): number {
  const name = manifest.name;
  const nameLower = name.toLowerCase();
  const queryLower = query.toLowerCase();

  // Exact match
  if (nameLower === queryLower) {
    return 100;
  }

  // Substring match (case insensitive)
  if (nameLower.includes(queryLower)) {
    return 80;
  }

  // Tokenized matching
  const queryTokens = queryLower.split(/\s+/).filter(Boolean);
  const nameWords = nameLower.split(/[\s\-:_]+/).filter(Boolean);

  // Word-start match: each query token matches start of a word in name
  const wordStartMatch = queryTokens.every((qt) =>
    nameWords.some((nw) => nw.startsWith(qt)),
  );
  if (wordStartMatch && queryTokens.length > 0) {
    return 60;
  }

  // Abbreviation / initials match with roman numeral mapping
  // e.g. "ck3" -> initials "c","k" + number "3"
  // Name "Crusader Kings III" -> initials "c","k" + roman "iii" -> "3"
  const initials = nameWords.map((w) => w[0]).join('');
  const nameWordsNormalized = nameWords.map((w) => ROMAN_MAP[w] ?? w);
  const initialsNormalized = nameWordsNormalized.map((w) => w[0]).join('');

  // Build a name representation for abbreviation matching:
  // Take initials of alphabetic words + convert roman numerals to digits
  const nameAbbrev = nameWords
    .map((w) => {
      const roman = ROMAN_MAP[w];
      if (roman) return roman;
      return w[0] ?? '';
    })
    .join('');

  if (nameAbbrev === queryLower || initials === queryLower || initialsNormalized === queryLower) {
    return 40;
  }

  // Partial abbreviation match: query is a prefix of the abbreviation
  if (nameAbbrev.startsWith(queryLower)) {
    return 30;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

interface GamesParams {
  action: 'list' | 'get' | 'search' | 'compare' | 'random' | 'unplayed';
  appid?: number;
  appid2?: number;
  query?: string;
  search?: string;
  filter?: string;
  include_store?: boolean;
  sort_by?: 'name' | 'size' | 'last_played' | 'playtime';
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

async function handleList(params: GamesParams): Promise<ToolResult> {
  try {
    let games = await readAllManifests();

    // Filter by search term
    if (params.search) {
      const term = params.search.toLowerCase();
      games = games.filter((g) =>
        g.name.toLowerCase().includes(term),
      );
    }

    // Build playtime map for sorting
    const playtimeMap = new Map(getAllPlaytimes().map(p => [p.appid, p.playtime]));

    // Sort
    const sortBy = params.sort_by ?? 'name';
    const order = (params.sort_order ?? 'asc') === 'desc' ? -1 : 1;
    games.sort((a, b) => {
      switch (sortBy) {
        case 'size':
          return (a.sizeOnDisk - b.sizeOnDisk) * order;
        case 'last_played':
          return (a.lastPlayed - b.lastPlayed) * order;
        case 'playtime':
          return ((playtimeMap.get(a.appid) ?? 0) - (playtimeMap.get(b.appid) ?? 0)) * order;
        case 'name':
        default:
          return a.name.localeCompare(b.name) * order;
      }
    });

    const total = games.length;
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    // Paginate
    const paginated = games.slice(offset, offset + limit);

    const results = paginated.map((g) => ({
      appid: g.appid,
      name: g.name,
      sizeOnDisk: formatBytes(g.sizeOnDisk),
      lastPlayed: formatTimestamp(g.lastPlayed),
      libraryPath: g.libraryPath,
    }));

    const output = {
      total,
      offset,
      limit,
      returned: results.length,
      games: results,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error listing games: ${msg}` }],
      isError: true,
    };
  }
}

async function handleGet(params: GamesParams): Promise<ToolResult> {
  try {
    if (!params.appid) {
      return {
        content: [{ type: 'text' as const, text: 'appid is required for get action' }],
        isError: true,
      };
    }

    const manifests = await readAllManifests();
    const manifest = manifests.find((m) => m.appid === params.appid);

    if (!manifest) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Game with appid ${params.appid} not found among installed games.`,
          },
        ],
        isError: true,
      };
    }

    // Base info from manifest
    const game: Record<string, unknown> = {
      appid: manifest.appid,
      name: manifest.name,
      installDir: manifest.installdir,
      sizeOnDisk: formatBytes(manifest.sizeOnDisk),
      sizeOnDiskBytes: manifest.sizeOnDisk,
      buildId: manifest.buildid,
      lastUpdated: formatTimestamp(manifest.lastUpdated),
      lastPlayed: formatTimestamp(manifest.lastPlayed),
      stateFlags: manifest.stateFlags,
      libraryPath: manifest.libraryPath,
    };

    // Merge user data (launch options, playtime)
    try {
      const launchOpts = getAppLaunchOptions(params.appid);
      if (launchOpts) {
        game.launchOptions = launchOpts;
      }
    } catch { /* userdata may not be available */ }

    try {
      const playtimeInfo = getPlaytime(params.appid);
      if (playtimeInfo) {
        game.playtime = formatPlaytime(playtimeInfo.playtime);
        game.playtimeMinutes = playtimeInfo.playtime;
      }
    } catch { /* userdata may not be available */ }

    // Proton / compatibility info
    try {
      const protonVersion = getGameProtonVersion(params.appid);
      if (protonVersion) {
        const prefixSize = getCompatDataSize(manifest.libraryPath, params.appid);
        game.proton = {
          version: protonVersion,
          prefixPath: `${manifest.libraryPath}/steamapps/compatdata/${params.appid}`,
          prefixSize: formatBytes(prefixSize),
        };
      }
    } catch {
      // compat info may not be available
    }

    // Workshop items
    try {
      const workshopPath = `${manifest.libraryPath}/steamapps/workshop/appworkshop_${params.appid}.acf`;
      const workshop = readWorkshopManifest(workshopPath);
      if (workshop && workshop.items.length > 0) {
        game.workshop = {
          itemCount: workshop.items.length,
          totalSize: formatBytes(workshop.sizeOnDisk),
          items: workshop.items.slice(0, 10).map((item) => ({
            publishedFileId: item.publishedFileId,
            size: formatBytes(item.size),
            timeUpdated: formatTimestamp(item.timeUpdated),
          })),
        };
      }
    } catch {
      // workshop info may not be available
    }

    // Optionally fetch store details
    if (params.include_store) {
      try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${params.appid}`;
        const response = await fetch(url);

        if (response.ok) {
          const data = (await response.json()) as Record<
            string,
            {
              success: boolean;
              data?: {
                short_description?: string;
                genres?: Array<{ id: string; description: string }>;
                developers?: string[];
                publishers?: string[];
                metacritic?: { score: number; url: string };
                platforms?: { windows: boolean; mac: boolean; linux: boolean };
                price_overview?: {
                  currency: string;
                  initial: number;
                  final: number;
                  discount_percent: number;
                  final_formatted: string;
                };
                is_free?: boolean;
                release_date?: { coming_soon: boolean; date: string };
                pc_requirements?: { minimum?: string; recommended?: string };
              };
            }
          >;

          const entry = data[String(params.appid)];
          if (entry?.success && entry.data) {
            const d = entry.data;
            game.short_description = d.short_description ?? null;
            game.genres = (d.genres ?? []).map((g) => g.description);
            game.developers = d.developers ?? [];
            game.publishers = d.publishers ?? [];
            game.metacritic = d.metacritic
              ? { score: d.metacritic.score, url: d.metacritic.url }
              : null;
            game.platforms = d.platforms ?? null;
            game.price = d.price_overview
              ? {
                  final_formatted: d.price_overview.final_formatted,
                  discount_percent: d.price_overview.discount_percent,
                  currency: d.price_overview.currency,
                }
              : d.is_free
                ? 'Free'
                : 'N/A';
            game.release_date = d.release_date ?? null;
            game.pc_requirements = d.pc_requirements ?? null;
          }
        }
      } catch {
        // Store details fetch failed — continue without them
      }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(game, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error getting game details: ${msg}` }],
      isError: true,
    };
  }
}

async function handleSearch(params: GamesParams): Promise<ToolResult> {
  try {
    if (!params.query) {
      return {
        content: [{ type: 'text' as const, text: 'query is required for search action' }],
        isError: true,
      };
    }

    const manifests = await readAllManifests();
    const installedAppids = new Set(manifests.map((m) => m.appid));

    const results: Array<{ appid: number; name: string; score: number; installed: boolean }> = [];

    for (const m of manifests) {
      const score = scoreSearch(params.query, m);
      if (score > 0) {
        results.push({ appid: m.appid, name: m.name, score, installed: true });
      }
    }

    // Sort by score descending, then name ascending for ties
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

    const top = results.slice(0, 20);

    // Optionally search the Steam store
    let storeResults: Array<{ appid: number; name: string; type: string; price: string; installed: boolean }> = [];
    if (params.include_store) {
      try {
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(params.query)}&l=english&cc=US`;
        const response = await fetch(url);

        if (response.ok) {
          const data = (await response.json()) as {
            total: number;
            items?: Array<{
              type: string;
              name: string;
              id: number;
              price?: { final?: number; currency?: string };
            }>;
          };

          if (data.items) {
            storeResults = data.items
              .filter((item) => !installedAppids.has(item.id))
              .map((item) => ({
                appid: item.id,
                name: item.name,
                type: item.type,
                price: item.price?.final != null
                  ? item.price.final === 0
                    ? 'Free'
                    : `$${(item.price.final / 100).toFixed(2)}`
                  : 'N/A',
                installed: false,
              }));
          }
        }
      } catch {
        // Store search failed — continue with local results only
      }
    }

    const output: Record<string, unknown> = {
      query: params.query,
      resultCount: top.length,
      totalMatches: results.length,
      results: top,
    };

    if (params.include_store) {
      output.storeResults = storeResults;
      output.storeResultCount = storeResults.length;
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error searching games: ${msg}` }],
      isError: true,
    };
  }
}

async function handleCompare(params: GamesParams): Promise<ToolResult> {
  try {
    if (!params.appid || !params.appid2) {
      return {
        content: [{ type: 'text' as const, text: 'appid and appid2 are required for compare action' }],
        isError: true,
      };
    }

    const manifests = await readAllManifests();
    const manifest1 = manifests.find((m) => m.appid === params.appid);
    const manifest2 = manifests.find((m) => m.appid === params.appid2);

    if (!manifest1 || !manifest2) {
      const missing = [];
      if (!manifest1) missing.push(params.appid);
      if (!manifest2) missing.push(params.appid2);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Game(s) not found among installed games: ${missing.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    const buildGameInfo = (manifest: AppManifest) => {
      const info: Record<string, unknown> = {
        appid: manifest.appid,
        name: manifest.name,
        sizeOnDisk: formatBytes(manifest.sizeOnDisk),
        sizeOnDiskBytes: manifest.sizeOnDisk,
        lastPlayed: formatTimestamp(manifest.lastPlayed),
        libraryPath: manifest.libraryPath,
      };

      try {
        const playtimeInfo = getPlaytime(manifest.appid);
        if (playtimeInfo) {
          info.playtime = formatPlaytime(playtimeInfo.playtime);
          info.playtimeMinutes = playtimeInfo.playtime;
        }
      } catch {
        // playtime may not be available
      }

      try {
        const protonVersion = getGameProtonVersion(manifest.appid);
        info.protonVersion = protonVersion ?? 'Native';
      } catch {
        info.protonVersion = 'Unknown';
      }

      return info;
    };

    const output = {
      game1: buildGameInfo(manifest1),
      game2: buildGameInfo(manifest2),
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error comparing games: ${msg}` }],
      isError: true,
    };
  }
}

async function handleRandom(params: GamesParams): Promise<ToolResult> {
  try {
    let games = await readAllManifests();

    // Exclude tool entries
    const toolPatterns = ['Steam Linux Runtime', 'Proton', 'Steamworks Common'];
    games = games.filter(
      (g) => !toolPatterns.some((pattern) => g.name.includes(pattern)),
    );

    // Apply name filter
    if (params.filter) {
      const term = params.filter.toLowerCase();
      games = games.filter((g) => g.name.toLowerCase().includes(term));
    }

    if (games.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No games found matching the criteria.',
          },
        ],
      };
    }

    const picked = games[Math.floor(Math.random() * games.length)]!;

    const result: Record<string, unknown> = {
      appid: picked.appid,
      name: picked.name,
      sizeOnDisk: formatBytes(picked.sizeOnDisk),
      lastPlayed: formatTimestamp(picked.lastPlayed),
    };

    try {
      const playtimeInfo = getPlaytime(picked.appid);
      if (playtimeInfo) {
        result.playtime = formatPlaytime(playtimeInfo.playtime);
        result.playtimeMinutes = playtimeInfo.playtime;
      }
    } catch {
      // playtime may not be available
    }

    const output = {
      totalCandidates: games.length,
      picked: result,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error picking random game: ${msg}` }],
      isError: true,
    };
  }
}

async function handleUnplayed(params: GamesParams): Promise<ToolResult> {
  try {
    const manifests = await readAllManifests();

    // Exclude tool entries
    const toolPatterns = ['Steam Linux Runtime', 'Proton', 'Steamworks Common', 'DFHack'];

    const neverPlayed = manifests.filter(
      (g) =>
        g.lastPlayed === 0 &&
        !toolPatterns.some((pattern) => g.name.includes(pattern)),
    );

    // Sort
    const sortBy = params.sort_by ?? 'size';
    const order = (params.sort_order ?? 'desc') === 'desc' ? -1 : 1;
    neverPlayed.sort((a, b) => {
      switch (sortBy) {
        case 'size':
          return (a.sizeOnDisk - b.sizeOnDisk) * order;
        case 'name':
        default:
          return a.name.localeCompare(b.name) * order;
      }
    });

    const totalSize = neverPlayed.reduce((sum, g) => sum + g.sizeOnDisk, 0);

    const games = neverPlayed.map((g) => ({
      appid: g.appid,
      name: g.name,
      sizeOnDisk: formatBytes(g.sizeOnDisk),
      sizeOnDiskBytes: g.sizeOnDisk,
    }));

    const output = {
      count: neverPlayed.length,
      totalSizeWasted: formatBytes(totalSize),
      totalSizeWastedBytes: totalSize,
      games,
    };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error listing pile of shame: ${msg}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGameTools(server: McpServer): void {
  server.tool(
    'games',
    'List, get, search, compare, random pick, or find unplayed games',
    {
      action: z.enum(['list', 'get', 'search', 'compare', 'random', 'unplayed']),
      appid: z.number().optional(),
      appid2: z.number().optional(),
      query: z.string().optional(),
      search: z.string().optional(),
      filter: z.string().optional(),
      include_store: z.boolean().optional(),
      sort_by: z.enum(['name', 'size', 'last_played', 'playtime']).optional(),
      sort_order: z.enum(['asc', 'desc']).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (params) => {
      switch (params.action) {
        case 'list':
          return handleList(params);
        case 'get':
          return handleGet(params);
        case 'search':
          return handleSearch(params);
        case 'compare':
          return handleCompare(params);
        case 'random':
          return handleRandom(params);
        case 'unplayed':
          return handleUnplayed(params);
      }
    },
  );
}
