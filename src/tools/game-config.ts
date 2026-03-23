import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSteamRunning } from '../steam/paths.js';
import {
  getLocalConfig,
  getAppLaunchOptions,
  setAppLaunchOptions,
} from '../steam/userdata.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESETS: Record<string, { description: string; options: string }> = {
  'pipewire-audio': {
    description: 'Force PipeWire audio backend (fixes audio issues on PipeWire systems)',
    options: '-sdlaudiodriver pipewire',
  },
  'force-vulkan': {
    description: 'Force Vulkan renderer',
    options: '-force-vulkan',
  },
  'force-dx11': {
    description: 'Force DirectX 11 (via DXVK for Proton games)',
    options: '-force-d3d11',
  },
  'disable-fullscreen-optimizations': {
    description: 'Disable fullscreen optimizations (can fix stuttering)',
    options: '-window-mode exclusive',
  },
  'skip-intro': {
    description: 'Skip intro videos (common for Source/Unity games)',
    options: '-novid',
  },
  'mangohud': {
    description: 'Enable MangoHud performance overlay',
    options: 'mangohud %command%',
  },
  'gamemode': {
    description: 'Enable Feral GameMode for performance optimization',
    options: 'gamemoderun %command%',
  },
  'mangohud-gamemode': {
    description: 'Enable both MangoHud overlay and GameMode',
    options: 'mangohud gamemoderun %command%',
  },
  'prime-nvidia': {
    description: 'Force NVIDIA GPU on hybrid graphics laptops',
    options: '__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia %command%',
  },
  'disable-esync': {
    description: 'Disable Esync (can fix hangs/crashes in some Proton games)',
    options: 'PROTON_NO_ESYNC=1 %command%',
  },
  'disable-fsync': {
    description: 'Disable Fsync (can fix issues on kernels without fsync support)',
    options: 'PROTON_NO_FSYNC=1 %command%',
  },
  'proton-log': {
    description: 'Enable Proton debug logging',
    options: 'PROTON_LOG=1 %command%',
  },
  'force-proton': {
    description: 'Force Proton for a native Linux game (useful if native port is broken)',
    options: 'STEAM_LINUX_RUNTIME_LOG=1 %command%',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Merge a %command%-based preset into existing launch options.
 *
 * - If existing options already contain %command%, insert new env vars / wrappers
 *   before the existing %command%.
 * - If the preset uses %command% but the current options do not, replace entirely.
 */
function mergeLaunchOptions(current: string, presetOptions: string): string {
  const presetUsesCommand = presetOptions.includes('%command%');

  if (!presetUsesCommand) {
    // Simple flag-style preset — just append if not already present
    if (current.includes(presetOptions.trim())) {
      return current;
    }
    return current ? `${current} ${presetOptions}` : presetOptions;
  }

  // Preset uses %command%
  if (!current || !current.includes('%command%')) {
    // Current has no %command%, just set the preset
    return presetOptions;
  }

  // Both use %command% — merge the parts before %command%
  const presetParts = presetOptions.split('%command%');
  const presetPrefix = presetParts[0].trim();
  const presetSuffix = (presetParts[1] ?? '').trim();

  const currentParts = current.split('%command%');
  const currentPrefix = currentParts[0].trim();
  const currentSuffix = (currentParts[1] ?? '').trim();

  // Avoid duplicating tokens already present
  const currentTokens = new Set(currentPrefix.split(/\s+/).filter(Boolean));
  const newTokens = presetPrefix.split(/\s+/).filter((t) => !currentTokens.has(t));

  const mergedPrefix = [...newTokens, currentPrefix].filter(Boolean).join(' ');
  const mergedSuffix = [currentSuffix, presetSuffix].filter(Boolean).join(' ');

  return mergedSuffix
    ? `${mergedPrefix} %command% ${mergedSuffix}`
    : `${mergedPrefix} %command%`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGameConfigTools(server: McpServer): void {
  server.tool(
    'game_config',
    'Launch options, presets, MangoHud, Steam settings',
    {
      action: z.enum(['get_launch_opts', 'set_launch_opts', 'presets', 'mangohud', 'steam_settings']),
      appid: z.number().optional(),
      options: z.string().optional(),
      preset: z.string().optional(),
      mangohud_action: z.enum(['show', 'set', 'reset']).optional(),
      settings: z.string().optional(),
    },
    async (params) => {
      try {
        switch (params.action) {
          // -------------------------------------------------------------------
          // get_launch_opts
          // -------------------------------------------------------------------
          case 'get_launch_opts': {
            if (!params.appid) {
              return {
                content: [
                  { type: 'text' as const, text: 'An appid is required for get_launch_opts.' },
                ],
                isError: true,
              };
            }

            const options = getAppLaunchOptions(params.appid);

            const output = {
              appid: params.appid,
              launchOptions: options ?? '',
              hasLaunchOptions: !!options,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          }

          // -------------------------------------------------------------------
          // set_launch_opts
          // -------------------------------------------------------------------
          case 'set_launch_opts': {
            if (!params.appid) {
              return {
                content: [
                  { type: 'text' as const, text: 'An appid is required for set_launch_opts.' },
                ],
                isError: true,
              };
            }

            if (params.options === undefined) {
              return {
                content: [
                  { type: 'text' as const, text: 'The "options" parameter is required for set_launch_opts.' },
                ],
                isError: true,
              };
            }

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
          }

          // -------------------------------------------------------------------
          // presets
          // -------------------------------------------------------------------
          case 'presets': {
            // If no preset specified, list all presets
            if (!params.preset) {
              const presetList = Object.entries(PRESETS).map(([name, info]) => ({
                name,
                description: info.description,
                options: info.options,
              }));

              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ presets: presetList }, null, 2),
                  },
                ],
              };
            }

            // Apply a preset — requires appid
            if (!params.appid) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'An appid is required when applying a preset.',
                  },
                ],
                isError: true,
              };
            }

            const presetInfo = PRESETS[params.preset];
            if (!presetInfo) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Unknown preset "${params.preset}". Available presets: ${Object.keys(PRESETS).join(', ')}`,
                  },
                ],
                isError: true,
              };
            }

            // Warn if Steam is running
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

            const previousOptions = getAppLaunchOptions(params.appid) ?? '';
            const newOptions = mergeLaunchOptions(previousOptions, presetInfo.options);

            setAppLaunchOptions(params.appid, newOptions);

            const presetOutput = {
              appid: params.appid,
              preset: params.preset,
              description: presetInfo.description,
              previousLaunchOptions: previousOptions || '(none)',
              newLaunchOptions: newOptions,
              success: true,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(presetOutput, null, 2) }],
            };
          }

          // -------------------------------------------------------------------
          // mangohud
          // -------------------------------------------------------------------
          case 'mangohud': {
            const mangoAction = params.mangohud_action ?? 'show';
            const home = os.homedir();
            const mangoDir = path.join(home, '.config', 'MangoHud');
            const globalConfigPath = path.join(mangoDir, 'MangoHud.conf');

            // Determine the config path to operate on
            let configPath = globalConfigPath;
            let configScope = 'global';

            if (params.appid) {
              configPath = path.join(mangoDir, `wine-${params.appid}.conf`);
              configScope = `game-specific (appid: ${params.appid})`;
            }

            if (mangoAction === 'show') {
              const results: Array<{ scope: string; path: string; exists: boolean; content: string }> = [];

              // Always show global config
              if (fs.existsSync(globalConfigPath)) {
                results.push({
                  scope: 'global',
                  path: globalConfigPath,
                  exists: true,
                  content: fs.readFileSync(globalConfigPath, 'utf-8'),
                });
              } else {
                results.push({
                  scope: 'global',
                  path: globalConfigPath,
                  exists: false,
                  content: '',
                });
              }

              // If appid provided, also show game-specific config
              if (params.appid) {
                const gameConfigPath = path.join(mangoDir, `wine-${params.appid}.conf`);
                if (fs.existsSync(gameConfigPath)) {
                  results.push({
                    scope: `game-specific (appid: ${params.appid})`,
                    path: gameConfigPath,
                    exists: true,
                    content: fs.readFileSync(gameConfigPath, 'utf-8'),
                  });
                } else {
                  results.push({
                    scope: `game-specific (appid: ${params.appid})`,
                    path: gameConfigPath,
                    exists: false,
                    content: '',
                  });
                }
              }

              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ configs: results }, null, 2) }],
              };
            }

            if (mangoAction === 'set') {
              if (!params.settings) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: 'The "settings" parameter is required for mangohud_action=set. Provide comma-separated key=value pairs.',
                    },
                  ],
                  isError: true,
                };
              }

              // Parse the settings string
              const newSettings = new Map<string, string>();
              for (const pair of params.settings.split(',')) {
                const trimmed = pair.trim();
                if (!trimmed) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) {
                  // Boolean-style setting (no value)
                  newSettings.set(trimmed, '');
                } else {
                  newSettings.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
                }
              }

              // Read existing config or start fresh
              let existingLines: string[] = [];
              if (fs.existsSync(configPath)) {
                existingLines = fs.readFileSync(configPath, 'utf-8').split('\n');
              }

              // Update existing lines and track which settings were updated
              const updatedKeys = new Set<string>();
              const resultLines: string[] = [];

              for (const line of existingLines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith('#')) {
                  resultLines.push(line);
                  continue;
                }

                const eqIdx = trimmedLine.indexOf('=');
                const key = eqIdx === -1 ? trimmedLine : trimmedLine.substring(0, eqIdx).trim();

                if (newSettings.has(key)) {
                  const val = newSettings.get(key)!;
                  resultLines.push(val ? `${key}=${val}` : key);
                  updatedKeys.add(key);
                } else {
                  resultLines.push(line);
                }
              }

              // Append any new settings that were not found in existing config
              for (const [key, val] of newSettings) {
                if (!updatedKeys.has(key)) {
                  resultLines.push(val ? `${key}=${val}` : key);
                }
              }

              // Ensure directory exists
              fs.mkdirSync(mangoDir, { recursive: true });

              const finalContent = resultLines.join('\n');
              fs.writeFileSync(configPath, finalContent, 'utf-8');

              const setOutput = {
                action: 'set',
                scope: configScope,
                path: configPath,
                updatedSettings: Object.fromEntries(newSettings),
                config: finalContent,
              };

              return {
                content: [{ type: 'text' as const, text: JSON.stringify(setOutput, null, 2) }],
              };
            }

            // mangoAction === 'reset'
            const defaultConfig = [
              'fps',
              'gpu_stats',
              'gpu_temp',
              'cpu_stats',
              'cpu_temp',
              'ram',
              'vram',
              'frame_timing',
              'position=top-left',
            ].join('\n');

            // Ensure directory exists
            fs.mkdirSync(mangoDir, { recursive: true });

            fs.writeFileSync(configPath, defaultConfig + '\n', 'utf-8');

            const resetOutput = {
              action: 'reset',
              scope: configScope,
              path: configPath,
              config: defaultConfig,
              message: 'MangoHud config reset to sensible defaults.',
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(resetOutput, null, 2) }],
            };
          }

          // -------------------------------------------------------------------
          // steam_settings
          // -------------------------------------------------------------------
          case 'steam_settings': {
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
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error in game_config (${params.action}): ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
