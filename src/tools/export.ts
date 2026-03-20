import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { steamApiRequest } from '../steam/api.js';
import { getUserConfig } from '../steam/paths.js';
import { getAllPlaytimes } from '../steam/userdata.js';
import { formatPlaytime, formatTimestamp } from '../util/format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OwnedGame {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_2weeks?: number;
  img_icon_url: string;
}

interface OwnedGamesResponse {
  response: {
    game_count: number;
    games: OwnedGame[];
  };
}

interface PlayerAchievement {
  apiname: string;
  achieved: number;
}

interface PlayerAchievementsResponse {
  playerstats: {
    steamID: string;
    gameName: string;
    achievements: PlayerAchievement[];
    success: boolean;
  };
}

interface ExportRow {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_formatted: string;
  last_played: string;
  achievements_unlocked: number | null;
  achievements_total: number | null;
  completion_pct: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: ExportRow): string {
  return [
    String(row.appid),
    escapeCsvField(row.name),
    String(row.playtime_forever),
    escapeCsvField(row.playtime_formatted),
    escapeCsvField(row.last_played),
    row.achievements_unlocked !== null ? String(row.achievements_unlocked) : '',
    row.achievements_total !== null ? String(row.achievements_total) : '',
    row.completion_pct !== null ? row.completion_pct : '',
  ].join(',');
}

async function fetchAchievements(
  appid: number,
  steamid: string,
): Promise<{ unlocked: number; total: number } | null> {
  try {
    const data = await steamApiRequest<PlayerAchievementsResponse>(
      'ISteamUserStats',
      'GetPlayerAchievements',
      'v1',
      { steamid, appid },
    );
    const achievements = data.playerstats?.achievements ?? [];
    if (achievements.length === 0) return null;
    const unlocked = achievements.filter((a) => a.achieved === 1).length;
    return { unlocked, total: achievements.length };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExportTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // export_library
  // -------------------------------------------------------------------------
  server.tool(
    'export_library',
    'Export the Steam game library to a JSON or CSV file, optionally including achievement data',
    {
      format: z
        .enum(['json', 'csv'])
        .default('json')
        .describe('Export format (default: json)'),
      output_path: z
        .string()
        .describe('File path to write the exported data to'),
      include_playtime: z
        .boolean()
        .default(true)
        .describe('Include local playtime data (default: true)'),
      include_achievements: z
        .boolean()
        .default(false)
        .describe('Include per-game achievement data (default: false — slow, fetches per-game)'),
    },
    async (params) => {
      try {
        const { format, output_path, include_playtime, include_achievements } = params;
        const config = getUserConfig();
        const steamid = config.steamId64;

        // Fetch owned games from API
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

        const games = ownedData.response.games ?? [];

        // Merge with local playtime data
        const localPlaytimes = include_playtime ? getAllPlaytimes() : [];
        const localMap = new Map<number, { playtime: number; lastPlayed: number }>();
        for (const lp of localPlaytimes) {
          localMap.set(lp.appid, { playtime: lp.playtime, lastPlayed: lp.lastPlayed });
        }

        // Build rows
        const rows: ExportRow[] = games.map((g) => {
          const local = localMap.get(g.appid);
          const playtime = g.playtime_forever || local?.playtime || 0;
          const lastPlayed = local?.lastPlayed ?? 0;

          return {
            appid: g.appid,
            name: g.name,
            playtime_forever: playtime,
            playtime_formatted: formatPlaytime(playtime),
            last_played: lastPlayed > 0 ? formatTimestamp(lastPlayed) : 'Never',
            achievements_unlocked: null,
            achievements_total: null,
            completion_pct: null,
          };
        });

        // Optionally fetch achievements in batches
        if (include_achievements) {
          const batchSize = 10;
          for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);
            const results = await Promise.all(
              batch.map((row) => fetchAchievements(row.appid, steamid)),
            );
            for (let j = 0; j < batch.length; j++) {
              const result = results[j];
              if (result) {
                batch[j].achievements_unlocked = result.unlocked;
                batch[j].achievements_total = result.total;
                batch[j].completion_pct =
                  result.total > 0
                    ? ((result.unlocked / result.total) * 100).toFixed(1) + '%'
                    : '0.0%';
              }
            }
          }
        }

        // Sort by playtime descending
        rows.sort((a, b) => b.playtime_forever - a.playtime_forever);

        // Write to file
        const resolvedPath = path.resolve(output_path);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        if (format === 'json') {
          fs.writeFileSync(resolvedPath, JSON.stringify(rows, null, 2), 'utf-8');
        } else {
          const header =
            'appid,name,playtime_forever,playtime_formatted,last_played,achievements_unlocked,achievements_total,completion_pct';
          const csvRows = rows.map(toCsvRow);
          fs.writeFileSync(resolvedPath, [header, ...csvRows].join('\n'), 'utf-8');
        }

        const output = {
          path: resolvedPath,
          format,
          game_count: rows.length,
          include_playtime,
          include_achievements,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error exporting library: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
