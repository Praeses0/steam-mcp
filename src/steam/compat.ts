import fs from 'node:fs';
import path from 'node:path';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import { getSteamDir, getLibraryFolders } from './paths.js';
import { getDirSize } from '../util/fs.js';

/**
 * Read compatibility tool overrides from the Steam config.
 *
 * Parses config/config.vdf looking for the CompatToolMapping section under
 * Software > Valve > Steam > CompatToolMapping.
 *
 * @returns A record mapping appid to its compatibility tool config.
 */
export function getCompatOverrides(): Record<number, { dest: string; src: string }> {
  const steamDir = getSteamDir();
  const configPath = path.join(steamDir, 'config', 'config.vdf');
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseVdf(content);

  // Navigate: InstallConfigStore > Software > Valve > Steam > CompatToolMapping
  const mapping = navigateVdf(
    parsed,
    'InstallConfigStore',
    'Software',
    'Valve',
    'Steam',
    'CompatToolMapping',
  );

  if (!mapping) return {};

  const result: Record<number, { dest: string; src: string }> = {};

  for (const [appidStr, value] of Object.entries(mapping)) {
    const appid = parseInt(appidStr, 10);
    if (isNaN(appid)) continue;
    if (typeof value === 'string') continue;

    const obj = value as VdfObject;
    result[appid] = {
      dest: (obj['name'] ?? obj['Name'] ?? '') as string,
      src: (obj['config'] ?? obj['Config'] ?? '') as string,
    };
  }

  return result;
}

/**
 * Calculate the total size of a compatdata prefix for a given appid.
 *
 * @param libraryPath - The library folder path containing the steamapps directory.
 * @param appid       - The Steam application ID.
 * @returns Total size in bytes, or 0 if the prefix does not exist.
 */
export function getCompatDataSize(libraryPath: string, appid: number): number {
  const compatDir = path.join(libraryPath, 'steamapps', 'compatdata', String(appid));

  if (!fs.existsSync(compatDir)) {
    return 0;
  }

  return getDirSize(compatDir);
}

/**
 * List all installed Proton/compatibility tool versions.
 *
 * Scans both:
 *   - {steamDir}/compatibilitytools.d/ (custom tools like GE-Proton)
 *   - All library steamapps/common/Proton* directories (official Proton)
 *
 * @returns Array of installed Proton versions with name, path, and size.
 */
export function getInstalledProtonVersions(): { name: string; path: string; size: number }[] {
  const steamDir = getSteamDir();
  const results: { name: string; path: string; size: number }[] = [];

  // Custom compatibility tools
  const customToolsDir = path.join(steamDir, 'compatibilitytools.d');
  if (fs.existsSync(customToolsDir)) {
    try {
      const entries = fs.readdirSync(customToolsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const toolPath = path.join(customToolsDir, entry.name);
          results.push({
            name: entry.name,
            path: toolPath,
            size: getDirSize(toolPath),
          });
        }
      }
    } catch {
      // Skip if unreadable
    }
  }

  // Official Proton versions in library folders
  const folders = getLibraryFolders();
  for (const folder of folders) {
    const commonDir = path.join(folder, 'steamapps', 'common');
    if (!fs.existsSync(commonDir)) continue;

    try {
      const entries = fs.readdirSync(commonDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('Proton')) {
          const toolPath = path.join(commonDir, entry.name);
          results.push({
            name: entry.name,
            path: toolPath,
            size: getDirSize(toolPath),
          });
        }
      }
    } catch {
      // Skip if unreadable
    }
  }

  return results;
}

/**
 * Get the Proton/compatibility tool version configured for a specific game.
 *
 * @param appid - The Steam application ID.
 * @returns The tool name (e.g. "proton_9", "GE-Proton10-33"), or null if none.
 */
export function getGameProtonVersion(appid: number): string | null {
  const overrides = getCompatOverrides();
  const override = overrides[appid];
  if (override && override.dest) {
    return override.dest;
  }
  return null;
}

/**
 * Get all Proton/compatibility tool version mappings at once.
 *
 * Parses config.vdf a single time and returns a map of appid -> tool name.
 * Use this instead of calling getGameProtonVersion() per game in a loop.
 *
 * @returns A record mapping appid to the configured compatibility tool name.
 */
export function getAllProtonVersionMappings(): Record<number, string> {
  const overrides = getCompatOverrides();
  const result: Record<number, string> = {};
  for (const [appid, override] of Object.entries(overrides)) {
    if (override.dest) {
      result[Number(appid)] = override.dest;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate a nested VDF object using a sequence of keys (case-insensitive).
 */
function navigateVdf(obj: VdfObject, ...keys: string[]): VdfObject | undefined {
  let current: VdfObject = obj;
  for (const key of keys) {
    const val = current[key];
    if (val && typeof val === 'object') {
      current = val as VdfObject;
      continue;
    }
    // Case-insensitive fallback
    const found = Object.entries(current).find(
      ([k]) => k.toLowerCase() === key.toLowerCase(),
    );
    if (!found || typeof found[1] === 'string') return undefined;
    current = found[1] as VdfObject;
  }
  return current;
}
