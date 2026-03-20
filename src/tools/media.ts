import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getUserDataDir } from '../steam/paths.js';

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
// Registration
// ---------------------------------------------------------------------------

export function registerMediaTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_game_media
  // -------------------------------------------------------------------------
  server.tool(
    'get_game_media',
    'Get header image, capsule art, hero, and logo URLs for a Steam game, plus any local grid image overrides',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const { appid } = params;

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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error getting game media: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
