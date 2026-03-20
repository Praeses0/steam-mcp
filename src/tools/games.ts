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

interface SearchResult {
  appid: number;
  name: string;
  score: number;
}

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
// Registration
// ---------------------------------------------------------------------------

export function registerGameTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // list_games
  // -------------------------------------------------------------------------
  server.tool(
    'list_games',
    'List installed Steam games across all libraries with optional filtering, sorting, and pagination',
    {
      search: z.string().optional().describe('Filter games by name (case-insensitive substring match)'),
      library: z.string().optional().describe('Filter by library path'),
      sort_by: z
        .enum(['name', 'size', 'last_played', 'playtime'])
        .default('name')
        .describe('Sort field'),
      sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
      limit: z.number().default(50).describe('Max results to return'),
      offset: z.number().default(0).describe('Number of results to skip (for pagination)'),
    },
    async (params) => {
      try {
        let games = await readAllManifests();

        // Filter by library path
        if (params.library) {
          games = games.filter(
            (g) => g.libraryPath === params.library,
          );
        }

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
        const order = params.sort_order === 'desc' ? -1 : 1;
        games.sort((a, b) => {
          switch (params.sort_by) {
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

        // Paginate
        const paginated = games.slice(params.offset, params.offset + params.limit);

        const results = paginated.map((g) => ({
          appid: g.appid,
          name: g.name,
          sizeOnDisk: formatBytes(g.sizeOnDisk),
          lastPlayed: formatTimestamp(g.lastPlayed),
          libraryPath: g.libraryPath,
        }));

        const output = {
          total,
          offset: params.offset,
          limit: params.limit,
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
    },
  );

  // -------------------------------------------------------------------------
  // get_game
  // -------------------------------------------------------------------------
  server.tool(
    'get_game',
    'Get comprehensive details for a single installed Steam game by appid',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
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
    },
  );

  // -------------------------------------------------------------------------
  // search_games
  // -------------------------------------------------------------------------
  server.tool(
    'search_games',
    'Smart tokenized search for installed Steam games. Supports exact matches, substring, word-start, and abbreviation/initials matching (e.g. "ck3" finds "Crusader Kings III"). Only searches installed games — use search_store to find any game on Steam.',
    {
      query: z.string().describe('Search query'),
    },
    async (params) => {
      try {
        const manifests = await readAllManifests();

        const results: SearchResult[] = [];

        for (const m of manifests) {
          const score = scoreSearch(params.query, m);
          if (score > 0) {
            results.push({ appid: m.appid, name: m.name, score });
          }
        }

        // Sort by score descending, then name ascending for ties
        results.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.name.localeCompare(b.name);
        });

        const top = results.slice(0, 20);

        const output = {
          query: params.query,
          resultCount: top.length,
          totalMatches: results.length,
          results: top,
        };

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
    },
  );

  // -------------------------------------------------------------------------
  // search_store
  // -------------------------------------------------------------------------
  server.tool(
    'search_store',
    'Search the Steam store for any game by name and get its appid. Uses the public Steam store search API (no API key needed). Use this to look up appids for install_game/uninstall_game.',
    {
      query: z.string().describe('Game name to search for'),
      limit: z.number().default(5).describe('Max results (default 5)'),
    },
    async (params) => {
      try {
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(params.query)}&l=english&cc=US`;
        const response = await fetch(url);

        if (!response.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Steam store search failed with status ${response.status}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await response.json()) as {
          total: number;
          items?: Array<{
            type: string;
            name: string;
            id: number;
            price?: { final?: number; currency?: string };
          }>;
        };

        if (!data.items || data.items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No results found for "${params.query}"`,
              },
            ],
          };
        }

        const results = data.items.slice(0, params.limit).map((item) => ({
          appid: item.id,
          name: item.name,
          type: item.type,
          price: item.price?.final != null
            ? item.price.final === 0
              ? 'Free'
              : `$${(item.price.final / 100).toFixed(2)}`
            : 'N/A',
        }));

        const output = {
          query: params.query,
          resultCount: results.length,
          totalOnStore: data.total,
          results,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error searching Steam store: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // compare_games
  // -------------------------------------------------------------------------
  server.tool(
    'compare_games',
    'Side-by-side comparison of two installed Steam games by appid',
    {
      appid1: z.number().describe('Steam application ID of the first game'),
      appid2: z.number().describe('Steam application ID of the second game'),
    },
    async (params) => {
      try {
        const manifests = await readAllManifests();
        const manifest1 = manifests.find((m) => m.appid === params.appid1);
        const manifest2 = manifests.find((m) => m.appid === params.appid2);

        if (!manifest1 || !manifest2) {
          const missing = [];
          if (!manifest1) missing.push(params.appid1);
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
    },
  );

  // -------------------------------------------------------------------------
  // random_game
  // -------------------------------------------------------------------------
  server.tool(
    'random_game',
    'Pick a random installed game to play, optionally filtering by name and excluding tool entries',
    {
      filter: z.string().optional().describe('Substring filter on game name (case-insensitive)'),
      exclude_tools: z
        .boolean()
        .default(true)
        .describe('Exclude runtime/tools like Steam Linux Runtime, Proton, Steamworks (default true)'),
    },
    async (params) => {
      try {
        let games = await readAllManifests();

        // Exclude tool entries
        if (params.exclude_tools) {
          const toolPatterns = ['Steam Linux Runtime', 'Proton', 'Steamworks Common'];
          games = games.filter(
            (g) => !toolPatterns.some((pattern) => g.name.includes(pattern)),
          );
        }

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
    },
  );

  // -------------------------------------------------------------------------
  // pile_of_shame
  // -------------------------------------------------------------------------
  server.tool(
    'pile_of_shame',
    'List installed games that have never been played (lastPlayed is 0), excluding tool entries',
    {
      sort_by: z.enum(['size', 'name']).default('size').describe('Sort field (default: size)'),
      sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction (default: desc)'),
    },
    async (params) => {
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
        const order = params.sort_order === 'desc' ? -1 : 1;
        neverPlayed.sort((a, b) => {
          switch (params.sort_by) {
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
    },
  );
}
