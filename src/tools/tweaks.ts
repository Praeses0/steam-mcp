import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSteamRunning } from '../steam/paths.js';
import { getAppLaunchOptions, setAppLaunchOptions } from '../steam/userdata.js';

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

export function registerTweaksTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // pcgamingwiki_fixes
  // -------------------------------------------------------------------------
  server.tool(
    'pcgamingwiki_fixes',
    'Look up fixes and tweaks for a game on PCGamingWiki',
    {
      appid: z.number().optional().describe('Steam application ID'),
      name: z.string().optional().describe('Game name to search for (used if appid is not provided)'),
    },
    async (params) => {
      try {
        if (!params.appid && !params.name) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Please provide either an appid or a game name to search.',
              },
            ],
            isError: true,
          };
        }

        let pageName: string | null = null;

        // Step 1: Find the wiki page
        if (params.appid) {
          // Search by Steam AppID using the Cargo API
          const cargoUrl =
            `https://www.pcgamingwiki.com/w/api.php?action=cargoquery` +
            `&tables=Infobox_game` +
            `&fields=Infobox_game._pageName=Page,Infobox_game.Steam_AppID` +
            `&where=Infobox_game.Steam_AppID=${params.appid}` +
            `&format=json`;

          const cargoResp = await fetch(cargoUrl);
          if (!cargoResp.ok) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `PCGamingWiki API returned status ${cargoResp.status} when searching by appid.`,
                },
              ],
              isError: true,
            };
          }

          const cargoData = (await cargoResp.json()) as {
            cargoquery?: Array<{ title: { Page: string; 'Steam AppID': string } }>;
          };

          if (cargoData.cargoquery && cargoData.cargoquery.length > 0) {
            pageName = cargoData.cargoquery[0].title.Page;
          }
        }

        if (!pageName && params.name) {
          // Search by name using opensearch
          const searchUrl =
            `https://www.pcgamingwiki.com/w/api.php?action=opensearch` +
            `&search=${encodeURIComponent(params.name)}` +
            `&limit=5&format=json`;

          const searchResp = await fetch(searchUrl);
          if (!searchResp.ok) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `PCGamingWiki API returned status ${searchResp.status} when searching by name.`,
                },
              ],
              isError: true,
            };
          }

          // OpenSearch returns: [query, [titles], [descriptions], [urls]]
          const searchData = (await searchResp.json()) as [string, string[], string[], string[]];
          const titles = searchData[1];

          if (titles && titles.length > 0) {
            pageName = titles[0];
          }
        }

        if (!pageName) {
          return {
            content: [
              {
                type: 'text' as const,
                text: params.appid
                  ? `No PCGamingWiki article found for appid ${params.appid}.`
                  : `No PCGamingWiki article found for "${params.name}".`,
              },
            ],
          };
        }

        // Step 2: Get the intro text
        let introText = '';
        try {
          const extractUrl =
            `https://www.pcgamingwiki.com/w/api.php?action=query` +
            `&titles=${encodeURIComponent(pageName)}` +
            `&prop=extracts&exintro=true&explaintext=true&format=json`;

          const extractResp = await fetch(extractUrl);
          if (extractResp.ok) {
            const extractData = (await extractResp.json()) as {
              query?: { pages?: Record<string, { extract?: string }> };
            };
            const pages = extractData.query?.pages;
            if (pages) {
              const pageObj = Object.values(pages)[0];
              if (pageObj?.extract) {
                introText = pageObj.extract;
              }
            }
          }
        } catch {
          // Intro extraction failed, continue without it
        }

        // Step 3: Get the article sections
        let sections: Array<{ index: string; line: string; level: string }> = [];
        try {
          const sectionsUrl =
            `https://www.pcgamingwiki.com/w/api.php?action=parse` +
            `&page=${encodeURIComponent(pageName)}` +
            `&prop=sections&format=json`;

          const sectionsResp = await fetch(sectionsUrl);
          if (sectionsResp.ok) {
            const sectionsData = (await sectionsResp.json()) as {
              parse?: {
                sections?: Array<{ index: string; line: string; level: string }>;
              };
            };
            if (sectionsData.parse?.sections) {
              sections = sectionsData.parse.sections;
            }
          }
        } catch {
          // Sections fetch failed, continue without them
        }

        const wikiUrl = `https://www.pcgamingwiki.com/wiki/${encodeURIComponent(pageName.replace(/ /g, '_'))}`;

        const output = {
          gameName: pageName,
          pcgamingwiki_url: wikiUrl,
          intro: introText || '(no intro text available)',
          sections: sections.map((s) => ({
            index: s.index,
            title: s.line,
            level: parseInt(s.level, 10),
          })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error looking up PCGamingWiki: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // launch_option_presets
  // -------------------------------------------------------------------------
  server.tool(
    'launch_option_presets',
    'List or apply common launch option presets',
    {
      action: z
        .enum(['list', 'apply'])
        .default('list')
        .describe('Action to perform: list available presets or apply one'),
      appid: z
        .number()
        .optional()
        .describe('Steam application ID (required for apply)'),
      preset: z
        .string()
        .optional()
        .describe('Preset name to apply (required for apply)'),
    },
    async (params) => {
      try {
        if (params.action === 'list') {
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

        // action === 'apply'
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

        if (!params.preset) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'A preset name is required when applying. Use action=list to see available presets.',
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
        const steamRunning = isSteamRunning();
        if (steamRunning) {
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

        const output = {
          appid: params.appid,
          preset: params.preset,
          description: presetInfo.description,
          previousLaunchOptions: previousOptions || '(none)',
          newLaunchOptions: newOptions,
          success: true,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error with launch option presets: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // mangohud_config
  // -------------------------------------------------------------------------
  server.tool(
    'mangohud_config',
    'Manage MangoHud configuration (global or per-game)',
    {
      action: z
        .enum(['show', 'set', 'reset'])
        .describe('Action: show current config, set specific settings, or reset to defaults'),
      appid: z
        .number()
        .optional()
        .describe('Steam application ID for game-specific config (omit for global)'),
      settings: z
        .string()
        .optional()
        .describe('Comma-separated key=value pairs to set, e.g. "fps=1,gpu_stats=1,cpu_stats=1,frame_timing=1"'),
    },
    async (params) => {
      try {
        const home = os.homedir();
        const mangoDir = path.join(home, '.config', 'MangoHud');
        const globalConfigPath = path.join(mangoDir, 'MangoHud.conf');

        // Determine the config path to operate on
        let configPath = globalConfigPath;
        let configScope = 'global';

        if (params.appid) {
          // Per-game config uses wine-{appid}.conf
          configPath = path.join(mangoDir, `wine-${params.appid}.conf`);
          configScope = `game-specific (appid: ${params.appid})`;
        }

        if (params.action === 'show') {
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

        if (params.action === 'set') {
          if (!params.settings) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'The "settings" parameter is required for action=set. Provide comma-separated key=value pairs.',
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
            // Skip empty lines and comments for key matching
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

          const output = {
            action: 'set',
            scope: configScope,
            path: configPath,
            updatedSettings: Object.fromEntries(newSettings),
            config: finalContent,
          };

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // action === 'reset'
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

        const output = {
          action: 'reset',
          scope: configScope,
          path: configPath,
          config: defaultConfig,
          message: 'MangoHud config reset to sensible defaults.',
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error managing MangoHud config: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
