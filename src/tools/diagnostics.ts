import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getSteamDir } from '../steam/paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the last N lines of a file.
 * Returns the lines as a string. Handles missing files gracefully.
 */
function readLastLines(filePath: string, lineCount: number): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Take last N lines (plus potential trailing empty line)
    const start = Math.max(0, lines.length - lineCount);
    return lines.slice(start).join('\n');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return `File not found: ${filePath}`;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDiagnosticsTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // parse_compat_log
  // -------------------------------------------------------------------------
  server.tool(
    'parse_compat_log',
    'Read the Proton/Wine compatibility log for debugging',
    {
      lines: z
        .number()
        .default(100)
        .describe('Number of lines to read from the end of the log'),
    },
    async (params) => {
      try {
        const steamPath = getSteamDir();

        // Common compat log locations
        const candidates = [
          path.join(steamPath, 'logs', 'compat_log.txt'),
          path.join(steamPath, 'logs', 'compat_log.previous.txt'),
          path.join(steamPath, 'logs', 'compatibility_log.txt'),
        ];

        let logContent: string | null = null;
        let usedPath: string | null = null;

        for (const candidate of candidates) {
          try {
            fs.accessSync(candidate, fs.constants.R_OK);
            logContent = readLastLines(candidate, params.lines);
            usedPath = candidate;
            break;
          } catch {
            continue;
          }
        }

        if (!logContent || !usedPath) {
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  'No compatibility log file found.',
                  'Searched locations:',
                  ...candidates.map((c) => `  - ${c}`),
                  '',
                  'The compat log is created when running games under Proton/Wine.',
                ].join('\n'),
              },
            ],
          };
        }

        const output = [
          `Compatibility log: ${usedPath}`,
          `Showing last ${params.lines} lines:`,
          '---',
          logContent,
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: output }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error parsing compat log: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // parse_shader_log
  // -------------------------------------------------------------------------
  server.tool(
    'parse_shader_log',
    'Read the shader compilation log for debugging',
    {
      lines: z
        .number()
        .default(100)
        .describe('Number of lines to read from the end of the log'),
    },
    async (params) => {
      try {
        const steamPath = getSteamDir();

        // Common shader log locations
        const candidates = [
          path.join(steamPath, 'logs', 'shader_log.txt'),
          path.join(steamPath, 'logs', 'shader_log.previous.txt'),
          path.join(steamPath, 'logs', 'shader_compile.log'),
          path.join(steamPath, 'logs', 'fossilize_engine.log'),
        ];

        let logContent: string | null = null;
        let usedPath: string | null = null;

        for (const candidate of candidates) {
          try {
            fs.accessSync(candidate, fs.constants.R_OK);
            logContent = readLastLines(candidate, params.lines);
            usedPath = candidate;
            break;
          } catch {
            continue;
          }
        }

        if (!logContent || !usedPath) {
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  'No shader log file found.',
                  'Searched locations:',
                  ...candidates.map((c) => `  - ${c}`),
                  '',
                  'Shader logs are created during shader pre-compilation or when games compile shaders.',
                ].join('\n'),
              },
            ],
          };
        }

        const output = [
          `Shader log: ${usedPath}`,
          `Showing last ${params.lines} lines:`,
          '---',
          logContent,
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: output }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text' as const, text: `Error parsing shader log: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );
}
