import fs from 'node:fs';
import path from 'node:path';
import { getSteamDir } from './paths.js';

/**
 * Read the last N lines from a Steam log file.
 *
 * Reads the file, splits into lines, and returns the tail.
 *
 * @param filePath - Absolute path to the log file.
 * @param lines    - Number of lines to return (default 100).
 * @returns Array of log line strings, or an empty array if the file doesn't exist.
 */
function readLastLines(filePath: string, lines: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const allLines = content.split('\n');

    // Remove trailing empty line from the final newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    if (lines >= allLines.length) {
      return allLines;
    }

    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Parse the last N lines from Steam's compatibility log.
 *
 * File: {steamDir}/logs/compat_log.txt
 *
 * @param lines - Number of lines to return (default 100).
 * @returns Array of raw log line strings.
 */
export function parseCompatLog(lines: number = 100): string[] {
  const steamDir = getSteamDir();
  const logPath = path.join(steamDir, 'logs', 'compat_log.txt');
  return readLastLines(logPath, lines);
}

/**
 * Parse the last N lines from Steam's shader compilation log.
 *
 * File: {steamDir}/logs/shader_log.txt
 *
 * @param lines - Number of lines to return (default 100).
 * @returns Array of raw log line strings.
 */
export function parseShaderLog(lines: number = 100): string[] {
  const steamDir = getSteamDir();
  const logPath = path.join(steamDir, 'logs', 'shader_log.txt');
  return readLastLines(logPath, lines);
}
