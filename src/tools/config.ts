import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import {
  getLocalConfig,
  getAppLaunchOptions,
  setAppLaunchOptions,
} from '../steam/userdata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSteamRunning(): boolean {
  try {
    execSync('pgrep -x steam', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerConfigTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_launch_options
  // -------------------------------------------------------------------------
  server.tool(
    'get_launch_options',
    'Read the launch options configured for a Steam game',
    {
      appid: z.number().describe('Steam application ID'),
    },
    async (params) => {
      try {
        const options = getAppLaunchOptions(params.appid);

        const output = {
          appid: params.appid,
          launchOptions: options ?? '',
          hasLaunchOptions: !!options,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error reading launch options: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // set_launch_options
  // -------------------------------------------------------------------------
  server.tool(
    'set_launch_options',
    'Set launch options for a Steam game. WARNING: Modifying localconfig.vdf while Steam is running may cause data loss.',
    {
      appid: z.number().describe('Steam application ID'),
      options: z.string().describe('Launch options string (e.g. "-novid -windowed")'),
    },
    async (params) => {
      try {
        // Check if Steam is running
        if (isSteamRunning()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  'WARNING: Steam is currently running!',
                  'Modifying localconfig.vdf while Steam is running will likely result in your changes being overwritten when Steam exits.',
                  'Please close Steam first, then try again.',
                  '',
                  'Launch options were NOT modified.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }

        setAppLaunchOptions(params.appid, params.options);

        const output = {
          appid: params.appid,
          launchOptions: params.options,
          success: true,
          message: `Launch options for appid ${params.appid} set to: ${params.options || '(cleared)'}`,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error setting launch options: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_steam_settings
  // -------------------------------------------------------------------------
  server.tool(
    'get_steam_settings',
    'Read Steam client settings from localconfig.vdf: FPS overlay, overlay toggle, controller type, streaming settings',
    {},
    async () => {
      try {
        const config = getLocalConfig();

        const root =
          config?.UserLocalConfigStore ?? config?.userlocalconfigstore;

        if (!root || typeof root !== 'object') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Could not read Steam settings: UserLocalConfigStore not found in localconfig.vdf',
              },
            ],
            isError: true,
          };
        }

        const rootObj = root as Record<string, unknown>;
        const system = (rootObj.system ?? rootObj.System) as
          | Record<string, unknown>
          | undefined;

        const fpsCornerMap: Record<string, string> = {
          '0': 'Off',
          '1': 'Top-left',
          '2': 'Top-right',
          '3': 'Bottom-right',
          '4': 'Bottom-left',
        };

        const settings: Record<string, unknown> = {};

        if (system && typeof system === 'object') {
          const fpsCorner = system.InGameOverlayShowFPSCorner as string | undefined;
          settings.fpsOverlay = {
            value: fpsCorner ?? '0',
            position: fpsCornerMap[fpsCorner ?? '0'] ?? 'Off',
          };

          settings.enableOverlay =
            system.EnableGameOverlay !== '0';

          settings.enableScreenshots =
            system.EnableScreenshots !== '0';

          // Streaming / Remote Play
          const streaming: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(system)) {
            if (
              key.toLowerCase().includes('streaming') ||
              key.toLowerCase().includes('remoteplay')
            ) {
              streaming[key] = value;
            }
          }
          if (Object.keys(streaming).length > 0) {
            settings.streaming = streaming;
          }

          // Controller
          const controller: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(system)) {
            if (key.toLowerCase().includes('controller')) {
              controller[key] = value;
            }
          }
          if (Object.keys(controller).length > 0) {
            settings.controller = controller;
          }
        } else {
          settings.note =
            'System section not found in localconfig.vdf. Settings may be stored elsewhere.';
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(settings, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error reading Steam settings: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
