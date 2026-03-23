import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readAllManifests } from '../steam/manifests.js';
import { isSteamRunning, openSteamUrl } from '../steam/paths.js';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGameControlTools(server: McpServer): void {
  server.tool(
    'game_control',
    'Install, uninstall, launch, verify, move, or open store page',
    {
      action: z.enum(['install', 'uninstall', 'launch', 'verify', 'move', 'store_page']),
      appid: z.number(),
    },
    async (params) => {
      try {
        // All actions require Steam to be running
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

        switch (params.action) {
          // -------------------------------------------------------------------
          // install
          // -------------------------------------------------------------------
          case 'install': {
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
          }

          // -------------------------------------------------------------------
          // uninstall
          // -------------------------------------------------------------------
          case 'uninstall': {
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
          }

          // -------------------------------------------------------------------
          // launch
          // -------------------------------------------------------------------
          case 'launch': {
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
          }

          // -------------------------------------------------------------------
          // verify
          // -------------------------------------------------------------------
          case 'verify': {
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
          }

          // -------------------------------------------------------------------
          // move
          // -------------------------------------------------------------------
          case 'move': {
            let gameName = `appid ${params.appid}`;
            const manifests = await readAllManifests();
            const manifest = manifests.find((m) => m.appid === params.appid);
            if (!manifest) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Game with appid ${params.appid} is not installed. Cannot move.`,
                  },
                ],
                isError: true,
              };
            }
            gameName = manifest.name;

            const url = `steam://move/${params.appid}`;
            openSteamUrl(url);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: [
                    `Move requested for "${gameName}" (appid: ${params.appid})`,
                    `Protocol URL: ${url}`,
                    '',
                    'Steam will show the move dialog. Select the target library folder in the Steam client.',
                  ].join('\n'),
                },
              ],
            };
          }

          // -------------------------------------------------------------------
          // store_page
          // -------------------------------------------------------------------
          case 'store_page': {
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
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error in game_control (${params.action}): ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
