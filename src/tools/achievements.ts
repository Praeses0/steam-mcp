import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getUserDataDir } from '../steam/paths.js';
import { parseVdf } from '../vdf/parser.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAchievementTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_achievement_stats
  // -------------------------------------------------------------------------
  server.tool(
    'get_achievement_stats',
    'Parse local achievement and stats data for a game from the userdata directory (best-effort — format varies by game)',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const { appid } = params;
        const userDataDir = getUserDataDir();
        const appDir = path.join(userDataDir, String(appid));

        if (!fs.existsSync(appDir)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No userdata directory found for appid ${appid}. The game may not have been played or may not store local data.`,
              },
            ],
          };
        }

        // Check for stats directory
        const statsDir = path.join(appDir, 'stats');
        let statsFiles: string[] = [];
        if (fs.existsSync(statsDir)) {
          try {
            statsFiles = fs.readdirSync(statsDir);
          } catch {
            // unreadable
          }
        }

        // Check for remotecache.vdf
        let remoteCacheData: Record<string, unknown> | null = null;
        const remoteCachePath = path.join(appDir, 'remotecache.vdf');
        if (fs.existsSync(remoteCachePath)) {
          try {
            const content = fs.readFileSync(remoteCachePath, 'utf-8');
            remoteCacheData = parseVdf(content) as Record<string, unknown>;
          } catch {
            // parse error — skip
          }
        }

        // List other files in the app userdata directory
        let appDirFiles: string[] = [];
        try {
          appDirFiles = fs.readdirSync(appDir);
        } catch {
          // unreadable
        }

        const output: Record<string, unknown> = {
          appid,
          userdataPath: appDir,
          filesInAppDir: appDirFiles,
        };

        if (statsFiles.length > 0) {
          output.statsDir = statsDir;
          output.statsFiles = statsFiles;
        } else {
          output.statsDir = null;
          output.statsNote = 'No stats directory found for this game.';
        }

        if (remoteCacheData) {
          output.remotecache = remoteCacheData;
        } else {
          output.remotecache = null;
          output.remotecacheNote = 'No remotecache.vdf found for this game.';
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error reading achievement stats: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
