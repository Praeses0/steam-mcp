import fs from 'node:fs';
import path from 'node:path';
import { parseVdf } from '../vdf/parser.js';
import { serializeVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import { getUserDataDir } from './paths.js';

/**
 * Parse and return the full localconfig.vdf for the current user.
 *
 * @returns The parsed VDF object.
 */
export function getLocalConfig(): VdfObject {
  const userDir = getUserDataDir();
  const configPath = path.join(userDir, 'config', 'localconfig.vdf');
  const content = fs.readFileSync(configPath, 'utf-8');
  return parseVdf(content);
}

/**
 * Navigate a nested VDF object using a sequence of keys.
 * Returns undefined if any key along the path does not exist or is a string.
 */
function navigateVdf(obj: VdfObject, ...keys: string[]): VdfObject | undefined {
  let current: VdfObject = obj;
  for (const key of keys) {
    const val = current[key];
    if (!val || typeof val === 'string') {
      // Try case-insensitive match
      const found = Object.entries(current).find(
        ([k]) => k.toLowerCase() === key.toLowerCase(),
      );
      if (!found || typeof found[1] === 'string') return undefined;
      current = found[1] as VdfObject;
    } else {
      current = val as VdfObject;
    }
  }
  return current;
}

/**
 * Get the Apps section from localconfig.vdf.
 *
 * The path in the VDF is:
 *   UserLocalConfigStore > Software > Valve > Steam > apps
 */
function getAppsSection(config: VdfObject): VdfObject | undefined {
  return navigateVdf(config, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps');
}

/**
 * Read the launch options for a given appid from localconfig.vdf.
 *
 * @param appid - The Steam application ID.
 * @returns The launch options string, or null if not set.
 */
export function getAppLaunchOptions(appid: number): string | null {
  const config = getLocalConfig();
  const apps = getAppsSection(config);
  if (!apps) return null;

  const appSection = apps[String(appid)];
  if (!appSection || typeof appSection === 'string') return null;

  const appObj = appSection as VdfObject;
  const options = appObj['LaunchOptions'] ?? appObj['launchoptions'];
  if (typeof options === 'string') return options;
  return null;
}

/**
 * Set launch options for a given appid in localconfig.vdf.
 *
 * This reads, modifies, and writes back the file atomically.
 *
 * @param appid   - The Steam application ID.
 * @param options - The launch options string to set.
 */
export function setAppLaunchOptions(appid: number, options: string): void {
  const userDir = getUserDataDir();
  const configPath = path.join(userDir, 'config', 'localconfig.vdf');
  const content = fs.readFileSync(configPath, 'utf-8');
  const config = parseVdf(content);

  // Ensure the full path exists, creating intermediate objects as needed
  const ensureObj = (parent: VdfObject, key: string): VdfObject => {
    // Case-insensitive lookup
    const existing = Object.entries(parent).find(
      ([k]) => k.toLowerCase() === key.toLowerCase(),
    );
    if (existing && typeof existing[1] === 'object') {
      return existing[1] as VdfObject;
    }
    const obj: VdfObject = {};
    parent[key] = obj;
    return obj;
  };

  const root = ensureObj(config, 'UserLocalConfigStore');
  const software = ensureObj(root, 'Software');
  const valve = ensureObj(software, 'Valve');
  const steam = ensureObj(valve, 'Steam');
  const apps = ensureObj(steam, 'apps');
  const app = ensureObj(apps, String(appid));

  app['LaunchOptions'] = options;

  const serialized = serializeVdf(config);
  fs.writeFileSync(configPath, serialized, 'utf-8');
}

/**
 * Get playtime information for a given appid from localconfig.vdf.
 *
 * @param appid - The Steam application ID.
 * @returns An object with playtime (in minutes) and lastPlayed (Unix timestamp), or null if not found.
 */
export function getPlaytime(appid: number): { playtime: number; lastPlayed: number } | null {
  const config = getLocalConfig();
  const apps = getAppsSection(config);
  if (!apps) return null;

  const appSection = apps[String(appid)];
  if (!appSection || typeof appSection === 'string') return null;

  const appObj = appSection as VdfObject;

  const playtime = parseInt(
    (appObj['Playtime'] ?? appObj['playtime'] ?? '0') as string,
    10,
  );
  const lastPlayed = parseInt(
    (appObj['LastPlayed'] ?? appObj['lastplayed'] ?? '0') as string,
    10,
  );

  if (playtime === 0 && lastPlayed === 0) return null;

  return { playtime, lastPlayed };
}

/**
 * Get playtime information for ALL apps in localconfig.vdf, not just installed ones.
 *
 * @returns Array of { appid, playtime (minutes), lastPlayed (unix timestamp) } for every app with data.
 */
export function getAllPlaytimes(): Array<{ appid: number; playtime: number; lastPlayed: number }> {
  const config = getLocalConfig();
  const apps = getAppsSection(config);
  if (!apps) return [];

  const results: Array<{ appid: number; playtime: number; lastPlayed: number }> = [];

  for (const [key, value] of Object.entries(apps)) {
    if (typeof value === 'string') continue;
    const appid = parseInt(key, 10);
    if (isNaN(appid)) continue;

    const appObj = value as VdfObject;
    const playtime = parseInt(
      (appObj['Playtime'] ?? appObj['playtime'] ?? '0') as string,
      10,
    );
    const lastPlayed = parseInt(
      (appObj['LastPlayed'] ?? appObj['lastplayed'] ?? '0') as string,
      10,
    );

    if (playtime > 0 || lastPlayed > 0) {
      results.push({ appid, playtime, lastPlayed });
    }
  }

  return results;
}
