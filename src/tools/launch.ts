import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readAllManifests } from '../steam/manifests.js';
import { isSteamRunning, openSteamUrl } from '../steam/paths.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLaunchTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // install_game
  // -------------------------------------------------------------------------
  server.tool(
    'install_game',
    'Tell Steam to start installing a game by appid. Steam must be running — it handles the actual download.',
    {
      appid: z.number().describe('Steam application ID to install'),
    },
    async (params) => {
      try {
        if (!isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Steam is not running. Please start Steam first.',
              },
            ],
            isError: true,
          };
        }

        // Check if already installed
        try {
          const manifests = await readAllManifests();
          const manifest = manifests.find((m) => m.appid === params.appid);
          if (manifest) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `"${manifest.name}" (appid: ${params.appid}) is already installed.`,
                },
              ],
            };
          }
        } catch {
          // If we can't check, proceed anyway
        }

        const url = `steam://install/${params.appid}`;
        openSteamUrl(url);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Install requested for appid ${params.appid}`,
                `Protocol URL: ${url}`,
                '',
                'Steam will show the install dialog. You may need to confirm in the Steam client.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error requesting install: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // uninstall_game
  // -------------------------------------------------------------------------
  server.tool(
    'uninstall_game',
    'Tell Steam to uninstall a game by appid. Steam must be running — it handles the actual removal.',
    {
      appid: z.number().describe('Steam application ID to uninstall'),
    },
    async (params) => {
      try {
        if (!isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Steam is not running. Please start Steam first.',
              },
            ],
            isError: true,
          };
        }

        // Check if the game is actually installed
        let gameName = `appid ${params.appid}`;
        try {
          const manifests = await readAllManifests();
          const manifest = manifests.find((m) => m.appid === params.appid);
          if (manifest) {
            gameName = manifest.name;
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Game with appid ${params.appid} is not installed. Nothing to uninstall.`,
                },
              ],
              isError: true,
            };
          }
        } catch {
          // If we can't verify, proceed anyway
        }

        const url = `steam://uninstall/${params.appid}`;
        openSteamUrl(url);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Uninstall requested for "${gameName}" (appid: ${params.appid})`,
                `Protocol URL: ${url}`,
                '',
                'Steam will show the uninstall confirmation dialog.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error requesting uninstall: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // launch_game
  // -------------------------------------------------------------------------
  server.tool(
    'launch_game',
    'Launch a Steam game via the steam:// protocol. Requires Steam to be running.',
    {
      appid: z.number().describe('Steam application ID to launch'),
    },
    async (params) => {
      try {
        // Verify Steam is running
        if (!isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Steam is not running. Please start Steam first, then try again.',
              },
            ],
            isError: true,
          };
        }

        // Optionally verify the game is installed
        let gameName = `appid ${params.appid}`;
        try {
          const manifests = await readAllManifests();
          const manifest = manifests.find((m) => m.appid === params.appid);
          if (manifest) {
            gameName = manifest.name;
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Game with appid ${params.appid} is not installed. Cannot launch.`,
                },
              ],
              isError: true,
            };
          }
        } catch {
          // If we can't verify, try launching anyway
        }

        // Launch via steam:// protocol
        const url = `steam://rungameid/${params.appid}`;
        openSteamUrl(url);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Launching "${gameName}" (appid: ${params.appid})`,
                `Protocol URL: ${url}`,
                '',
                'The game launch has been requested. Steam will handle the actual launch process.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error launching game: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // verify_game
  // -------------------------------------------------------------------------
  server.tool(
    'verify_game',
    'Trigger Steam\'s file verification for an installed game. Steam must be running.',
    {
      appid: z.number().describe('Steam application ID to verify'),
    },
    async (params) => {
      try {
        if (!isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Steam is not running. Please start Steam first.',
              },
            ],
            isError: true,
          };
        }

        // Verify the game is installed
        let gameName = `appid ${params.appid}`;
        try {
          const manifests = await readAllManifests();
          const manifest = manifests.find((m) => m.appid === params.appid);
          if (manifest) {
            gameName = manifest.name;
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Game with appid ${params.appid} is not installed. Cannot verify.`,
                },
              ],
              isError: true,
            };
          }
        } catch {
          // If we can't verify installation, proceed anyway
        }

        const url = `steam://validate/${params.appid}`;
        openSteamUrl(url);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `File verification requested for "${gameName}" (appid: ${params.appid})`,
                `Protocol URL: ${url}`,
                '',
                'Steam will verify the integrity of game files. This may take a while depending on the game size.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error requesting file verification: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // open_store_page
  // -------------------------------------------------------------------------
  server.tool(
    'open_store_page',
    'Open a game\'s Steam store page in the Steam client. Steam must be running.',
    {
      appid: z.number().describe('Steam application ID to open the store page for'),
    },
    async (params) => {
      try {
        if (!isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Steam is not running. Please start Steam first.',
              },
            ],
            isError: true,
          };
        }

        const url = `steam://store/${params.appid}`;
        openSteamUrl(url);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Opening store page for appid ${params.appid}`,
                `Protocol URL: ${url}`,
                '',
                'Steam will open the store page for this game.',
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error opening store page: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
