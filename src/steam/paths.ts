import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import type { UserConfig } from './types.js';

/** SteamID64 offset used to derive SteamID32. */
const STEAMID64_BASE = 76561197960265728n;

/**
 * Resolve the Steam installation directory.
 *
 * Checks, in order:
 *   1. ~/.local/share/Steam/
 *   2. $XDG_DATA_HOME/Steam/
 *
 * @returns Absolute path to the Steam directory.
 * @throws If no Steam installation is found.
 */
export function getSteamDir(): string {
  const home = os.homedir();

  // Primary location
  const primary = path.join(home, '.local', 'share', 'Steam');
  if (fs.existsSync(primary)) {
    return primary;
  }

  // XDG fallback
  const xdgDataHome = process.env['XDG_DATA_HOME'];
  if (xdgDataHome) {
    const xdgPath = path.join(xdgDataHome, 'Steam');
    if (fs.existsSync(xdgPath)) {
      return xdgPath;
    }
  }

  throw new Error(
    'Steam installation not found. Checked ~/.local/share/Steam/ and $XDG_DATA_HOME/Steam/',
  );
}

/**
 * Parse config/loginusers.vdf and return the most-recently-used user's config.
 *
 * @returns The UserConfig for the user with MostRecent=1.
 * @throws If loginusers.vdf cannot be found or parsed, or no recent user exists.
 */
export function getUserConfig(): UserConfig {
  const steamDir = getSteamDir();
  const loginUsersPath = path.join(steamDir, 'config', 'loginusers.vdf');
  const content = fs.readFileSync(loginUsersPath, 'utf-8');
  const parsed = parseVdf(content);

  const users = parsed['users'] as VdfObject | undefined;
  if (!users) {
    throw new Error('No "users" section found in loginusers.vdf');
  }

  for (const [steamId64, userData] of Object.entries(users)) {
    if (typeof userData !== 'object') continue;

    const userObj = userData as VdfObject;
    if (userObj['MostRecent'] === '1' || userObj['mostrecent'] === '1') {
      const id64 = BigInt(steamId64);
      const id32 = Number(id64 - STEAMID64_BASE);

      return {
        steamId64,
        steamId32: id32,
        accountName: (userObj['AccountName'] ?? userObj['accountname'] ?? '') as string,
        personaName: (userObj['PersonaName'] ?? userObj['personaname'] ?? '') as string,
      };
    }
  }

  throw new Error('No user with MostRecent=1 found in loginusers.vdf');
}

/**
 * Get the userdata directory for the most-recently-used Steam user.
 *
 * @returns Absolute path to userdata/{steamId32}/
 */
export function getUserDataDir(): string {
  const steamDir = getSteamDir();
  const user = getUserConfig();
  return path.join(steamDir, 'userdata', String(user.steamId32));
}

/**
 * Parse config/libraryfolders.vdf and return all library folder paths.
 *
 * @returns Array of absolute paths to Steam library folders.
 */
export function getLibraryFolders(): string[] {
  const steamDir = getSteamDir();
  const vdfPath = path.join(steamDir, 'config', 'libraryfolders.vdf');
  const content = fs.readFileSync(vdfPath, 'utf-8');
  const parsed = parseVdf(content);

  const libraryfolders = parsed['libraryfolders'] ??
    parsed['LibraryFolders'] as VdfObject | undefined;

  if (!libraryfolders || typeof libraryfolders === 'string') {
    throw new Error('No "libraryfolders" section found in libraryfolders.vdf');
  }

  const folders: string[] = [];
  const foldersObj = libraryfolders as VdfObject;

  for (const [key, value] of Object.entries(foldersObj)) {
    // Keys are "0", "1", "2", etc.
    if (!/^\d+$/.test(key)) continue;
    if (typeof value === 'string') {
      // Older format: key -> path string
      folders.push(value);
    } else {
      // Newer format: key -> object with "path" field
      const obj = value as VdfObject;
      const folderPath = obj['path'];
      if (typeof folderPath === 'string') {
        folders.push(folderPath);
      }
    }
  }

  return folders;
}

/**
 * Check whether Steam is currently running.
 *
 * Uses `pgrep -x steam` to detect the Steam process.
 *
 * @returns true if Steam is running, false otherwise.
 */
export function isSteamRunning(): boolean {
  try {
    execSync('pgrep -x steam', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
