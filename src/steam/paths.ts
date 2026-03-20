import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import type { UserConfig } from './types.js';

/** SteamID64 offset used to derive SteamID32. */
const STEAMID64_BASE = 76561197960265728n;

/** Current platform. */
const PLATFORM = process.platform;

/**
 * Resolve the Steam installation directory.
 *
 * Platform-specific locations:
 *   - Linux: ~/.local/share/Steam/, $XDG_DATA_HOME/Steam/, ~/.steam/steam/
 *   - macOS: ~/Library/Application Support/Steam/
 *   - Windows: C:\Program Files (x86)\Steam\, registry fallback
 *
 * @returns Absolute path to the Steam directory.
 * @throws If no Steam installation is found.
 */
export function getSteamDir(): string {
  const home = os.homedir();
  const candidates: string[] = [];

  if (PLATFORM === 'linux') {
    candidates.push(path.join(home, '.local', 'share', 'Steam'));
    const xdgDataHome = process.env['XDG_DATA_HOME'];
    if (xdgDataHome) {
      candidates.push(path.join(xdgDataHome, 'Steam'));
    }
    candidates.push(path.join(home, '.steam', 'steam'));
  } else if (PLATFORM === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Steam'));
  } else if (PLATFORM === 'win32') {
    candidates.push('C:\\Program Files (x86)\\Steam');
    candidates.push('C:\\Program Files\\Steam');
    candidates.push(path.join(home, 'Steam'));
    // Try registry
    try {
      const regOutput = execSync(
        'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const match = regOutput.match(/InstallPath\s+REG_SZ\s+(.+)/);
      if (match?.[1]) {
        candidates.unshift(match[1].trim());
      }
    } catch { /* registry not available */ }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Steam installation not found. Platform: ${PLATFORM}. Checked: ${candidates.join(', ')}`,
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
 * Open a steam:// protocol URL using the platform-appropriate method.
 *
 * - Linux: spawn `steam <url>`
 * - macOS: spawn `open <url>`
 * - Windows: spawn `start "" <url>`
 */
export function openSteamUrl(url: string): void {
  let child;
  if (PLATFORM === 'win32') {
    child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  } else if (PLATFORM === 'darwin') {
    child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('steam', [url], { detached: true, stdio: 'ignore' });
  }
  child.unref();
}

/**
 * Check whether Steam is currently running.
 *
 * Platform-specific:
 *   - Linux: pgrep -x steam
 *   - macOS: pgrep -x steam_osx (or steam)
 *   - Windows: tasklist for steam.exe
 *
 * @returns true if Steam is running, false otherwise.
 */
export function isSteamRunning(): boolean {
  try {
    if (PLATFORM === 'win32') {
      const output = execSync('tasklist /FI "IMAGENAME eq steam.exe" /NH', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output.toLowerCase().includes('steam.exe');
    } else {
      // Linux and macOS both support pgrep
      execSync('pgrep -xi steam', { stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
}
