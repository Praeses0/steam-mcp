import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readShortcuts, writeShortcuts } from '../steam/shortcuts.js';
import type { ShortcutEntry } from '../steam/types.js';
import { formatTimestamp } from '../util/format.js';

/**
 * Generate a deterministic appid for a non-Steam shortcut.
 *
 * Uses the djb2 hash of the exe + name string, then sets the high bit and
 * clears bit 24 to avoid collisions with real Steam appids.
 */
function generateShortcutId(exe: string, name: string): number {
  let hash = 5381;
  const str = exe + name;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash | 0x80000000) >>> 0;
}

export function registerShortcutTools(server: McpServer): void {
  server.tool(
    'shortcuts',
    'Non-Steam shortcuts: list, add, remove, import from Lutris',
    {
      action: z.enum(['list', 'add', 'remove', 'import_lutris']),
      appid: z.number().optional(),
      name: z.string().optional(),
      exe: z.string().describe('Absolute path to the executable').optional(),
      start_dir: z
        .string()
        .describe("Working directory (defaults to exe's parent directory)")
        .optional(),
      launch_options: z.string().optional(),
      tags: z.array(z.string()).optional(),
      game_ids: z
        .array(z.number())
        .describe('Lutris game IDs to import; omit for all')
        .optional(),
    },
    async ({ action, appid, name, exe, start_dir, launch_options, tags, game_ids }) => {
      switch (action) {
        // ---------------------------------------------------------------------
        // list
        // ---------------------------------------------------------------------
        case 'list': {
          try {
            const shortcuts = await readShortcuts();

            if (shortcuts.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No non-Steam game shortcuts found.',
                  },
                ],
              };
            }

            const results = shortcuts.map((s) => ({
              appid: s.appid,
              name: s.appName,
              exe: s.exe,
              startDir: s.startDir,
              launchOptions: s.launchOptions || '',
              lastPlayed: formatTimestamp(s.lastPlayTime),
              tags: s.tags,
            }));

            const output = {
              count: results.length,
              shortcuts: results,
            };

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error listing shortcuts: ${msg}` },
              ],
              isError: true,
            };
          }
        }

        // ---------------------------------------------------------------------
        // add
        // ---------------------------------------------------------------------
        case 'add': {
          try {
            if (!name || !exe) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: "name" and "exe" are required for the add action.',
                  },
                ],
                isError: true,
              };
            }

            const shortcuts = readShortcuts();
            const startDir = start_dir ?? path.dirname(exe);
            const id = generateShortcutId(exe, name);

            const entry: ShortcutEntry = {
              appid: id,
              appName: name,
              exe,
              startDir,
              launchOptions: launch_options ?? '',
              lastPlayTime: 0,
              tags: tags ?? [],
            };

            shortcuts.push(entry);
            writeShortcuts(shortcuts);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      message: 'Shortcut added successfully',
                      shortcut: {
                        appid: entry.appid,
                        name: entry.appName,
                        exe: entry.exe,
                        startDir: entry.startDir,
                        launchOptions: entry.launchOptions,
                        tags: entry.tags,
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error adding shortcut: ${msg}` },
              ],
              isError: true,
            };
          }
        }

        // ---------------------------------------------------------------------
        // remove
        // ---------------------------------------------------------------------
        case 'remove': {
          try {
            if (appid === undefined && name === undefined) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: Either appid or name must be provided.',
                  },
                ],
                isError: true,
              };
            }

            const shortcuts = readShortcuts();
            const index = shortcuts.findIndex((s) => {
              if (appid !== undefined) return s.appid === appid;
              return s.appName === name;
            });

            if (index === -1) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Shortcut not found matching ${appid !== undefined ? `appid ${appid}` : `name "${name}"`}.`,
                  },
                ],
                isError: true,
              };
            }

            const removed = shortcuts.splice(index, 1)[0];
            writeShortcuts(shortcuts);

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      message: 'Shortcut removed successfully',
                      removed: {
                        appid: removed.appid,
                        name: removed.appName,
                        exe: removed.exe,
                        startDir: removed.startDir,
                        launchOptions: removed.launchOptions,
                        tags: removed.tags,
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                { type: 'text' as const, text: `Error removing shortcut: ${msg}` },
              ],
              isError: true,
            };
          }
        }

        // ---------------------------------------------------------------------
        // import_lutris
        // ---------------------------------------------------------------------
        case 'import_lutris': {
          try {
            // Retrieve the game list from Lutris
            let rawJson: string;
            try {
              rawJson = execSync('lutris --list-games --json', {
                encoding: 'utf-8',
                timeout: 15_000,
              });
            } catch {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: Could not run "lutris --list-games --json". Is Lutris installed and in PATH?',
                  },
                ],
                isError: true,
              };
            }

            interface LutrisGame {
              id: number;
              name: string;
              slug: string;
              runner: string;
              platform: string;
              directory: string;
            }

            let lutrisGames: LutrisGame[];
            try {
              lutrisGames = JSON.parse(rawJson) as LutrisGame[];
            } catch {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: Failed to parse Lutris JSON output.',
                  },
                ],
                isError: true,
              };
            }

            // Filter to requested IDs if provided
            if (game_ids !== undefined && game_ids.length > 0) {
              const idSet = new Set(game_ids);
              lutrisGames = lutrisGames.filter((g) => idSet.has(g.id));
            }

            if (lutrisGames.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No matching Lutris games found.',
                  },
                ],
              };
            }

            const shortcuts = readShortcuts();
            const existingNames = new Set(
              shortcuts.map((s) => s.appName.toLowerCase()),
            );

            const imported: string[] = [];
            const skipped: string[] = [];

            for (const game of lutrisGames) {
              if (existingNames.has(game.name.toLowerCase())) {
                skipped.push(game.name);
                continue;
              }

              const lutrisExe = 'lutris';
              const lutrisLaunchOptions = `lutris:rungameid/${game.id}`;
              const id = generateShortcutId(lutrisExe, game.name);

              shortcuts.push({
                appid: id,
                appName: game.name,
                exe: lutrisExe,
                startDir: os.homedir(),
                launchOptions: lutrisLaunchOptions,
                lastPlayTime: 0,
                tags: ['Lutris'],
              });

              imported.push(game.name);
            }

            if (imported.length > 0) {
              writeShortcuts(shortcuts);
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      message: `Imported ${imported.length} game(s), skipped ${skipped.length} already-existing shortcut(s).`,
                      imported,
                      skipped,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error importing Lutris games: ${msg}`,
                },
              ],
              isError: true,
            };
          }
        }
      }
    },
  );
}
