import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getLibraries } from '../steam/library.js';
import { readAllManifests } from '../steam/manifests.js';
import { getAllPlaytimes } from '../steam/userdata.js';
import { formatBytes, formatPlaytime, formatTimestamp } from '../util/format.js';

export function registerLibraryTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // list_libraries
  // -------------------------------------------------------------------------
  server.tool(
    'list_libraries',
    'List all Steam library folders with path, total size, free space, game count, and mount status',
    {},
    async () => {
      try {
        const libraries = getLibraries();

        const results = libraries.map((lib) => ({
          path: lib.path,
          label: lib.label,
          totalSize: formatBytes(lib.totalSize),
          freeSpace: formatBytes(lib.freeSpace),
          gameCount: lib.appids.length,
          mounted: lib.mounted,
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error listing libraries: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_library_stats
  // -------------------------------------------------------------------------
  server.tool(
    'get_library_stats',
    'Get aggregate statistics across all Steam libraries: total games, total size, playtime, top games by size, recently played, and pile of shame (installed but never played)',
    {},
    async () => {
      try {
        const libraries = getLibraries();
        const manifests = await readAllManifests();

        // Total stats
        const totalGames = manifests.length;
        const totalSize = manifests.reduce((sum, m) => sum + m.sizeOnDisk, 0);

        // Games per library
        const gamesPerLibrary = libraries.map((lib) => ({
          path: lib.path,
          label: lib.label,
          gameCount: lib.appids.length,
          totalSize: formatBytes(
            manifests
              .filter((m) => m.libraryPath === lib.path)
              .reduce((sum, m) => sum + m.sizeOnDisk, 0),
          ),
        }));

        // Top 10 by size
        const sortedBySize = [...manifests].sort(
          (a, b) => b.sizeOnDisk - a.sizeOnDisk,
        );
        const top10BySize = sortedBySize.slice(0, 10).map((m) => ({
          appid: m.appid,
          name: m.name,
          size: formatBytes(m.sizeOnDisk),
        }));

        // Top 10 recently played
        const sortedByPlayed = [...manifests]
          .filter((m) => m.lastPlayed > 0)
          .sort((a, b) => b.lastPlayed - a.lastPlayed);
        const top10RecentlyPlayed = sortedByPlayed.slice(0, 10).map((m) => ({
          appid: m.appid,
          name: m.name,
          lastPlayed: formatTimestamp(m.lastPlayed),
        }));

        // Pile of shame: installed but never played (lastPlayed === 0)
        const pileOfShame = manifests
          .filter((m) => m.lastPlayed === 0)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => ({
            appid: m.appid,
            name: m.name,
            size: formatBytes(m.sizeOnDisk),
          }));

        // Total playtime (best effort) — parse localconfig.vdf once
        const allPlaytimes = getAllPlaytimes();
        const playtimeMap = new Map(allPlaytimes.map(p => [p.appid, p.playtime]));
        let totalPlaytimeMinutes = 0;
        for (const m of manifests) {
          totalPlaytimeMinutes += playtimeMap.get(m.appid) ?? 0;
        }

        const output = {
          totalGames,
          totalSize: formatBytes(totalSize),
          totalPlaytime: formatPlaytime(totalPlaytimeMinutes),
          gamesPerLibrary,
          top10BySize,
          top10RecentlyPlayed,
          pileOfShame: {
            count: pileOfShame.length,
            games: pileOfShame,
          },
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error getting library stats: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
