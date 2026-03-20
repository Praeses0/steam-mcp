import fs from 'node:fs';
import path from 'node:path';
import { parseBinaryVdf } from '../vdf/binary-parser.js';
import { serializeBinaryVdf } from '../vdf/binary-writer.js';
import type { VdfObject } from '../vdf/types.js';
import { getUserDataDir } from './paths.js';
import type { ShortcutEntry } from './types.js';

/**
 * Read non-Steam game shortcuts from the binary shortcuts.vdf file.
 *
 * The file lives at userdata/{id}/config/shortcuts.vdf and uses Valve's
 * binary VDF format. Each shortcut is a numbered sub-object under the
 * root "shortcuts" key.
 *
 * @returns Array of ShortcutEntry objects. Returns an empty array if the file
 *          does not exist.
 */
export function readShortcuts(): ShortcutEntry[] {
  const userDir = getUserDataDir();
  const shortcutsPath = path.join(userDir, 'config', 'shortcuts.vdf');

  if (!fs.existsSync(shortcutsPath)) {
    return [];
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(shortcutsPath);
  } catch {
    return [];
  }

  if (buffer.length === 0) {
    return [];
  }

  const parsed = parseBinaryVdf(buffer);

  // The root object typically has a "shortcuts" key containing numbered entries
  const shortcuts = (parsed['shortcuts'] ?? parsed['Shortcuts'] ?? parsed) as VdfObject;

  const entries: ShortcutEntry[] = [];

  for (const [key, value] of Object.entries(shortcuts)) {
    if (typeof value === 'string') continue;

    const obj = value as VdfObject;

    // Extract tags from the "tags" sub-object
    const tagsObj = obj['tags'] ?? obj['Tags'];
    const tags: string[] = [];
    if (tagsObj && typeof tagsObj === 'object') {
      for (const tagValue of Object.values(tagsObj as VdfObject)) {
        if (typeof tagValue === 'string') {
          tags.push(tagValue);
        }
      }
    }

    entries.push({
      appid: parseInt(str(obj['appid'] ?? obj['AppId'] ?? obj['appID'] ?? '0'), 10),
      appName: str(obj['appname'] ?? obj['AppName'] ?? obj['app_name'] ?? ''),
      exe: str(obj['exe'] ?? obj['Exe'] ?? ''),
      startDir: str(obj['StartDir'] ?? obj['startdir'] ?? ''),
      launchOptions: str(obj['LaunchOptions'] ?? obj['launchoptions'] ?? ''),
      lastPlayTime: parseInt(str(obj['LastPlayTime'] ?? obj['lastplaytime'] ?? '0'), 10),
      tags,
    });
  }

  return entries;
}

/**
 * Write an array of ShortcutEntry objects back to the binary shortcuts.vdf file.
 *
 * The file structure is: root object with a "shortcuts" key containing
 * numbered sub-objects "0", "1", "2", etc.
 *
 * A backup of the existing file is created at shortcuts.vdf.bak before
 * writing.
 *
 * @param shortcuts - The shortcut entries to persist.
 */
export function writeShortcuts(shortcuts: ShortcutEntry[]): void {
  const userDir = getUserDataDir();
  const configDir = path.join(userDir, 'config');
  const shortcutsPath = path.join(configDir, 'shortcuts.vdf');
  const backupPath = shortcutsPath + '.bak';

  // Ensure the config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Back up the existing file if present
  if (fs.existsSync(shortcutsPath)) {
    fs.copyFileSync(shortcutsPath, backupPath);
  }

  // Build the VDF object structure
  const entriesObj: VdfObject = {};

  for (let i = 0; i < shortcuts.length; i++) {
    const s = shortcuts[i];
    const entry: VdfObject = {
      appid: String(s.appid),
      AppName: s.appName,
      Exe: s.exe,
      StartDir: s.startDir,
      LaunchOptions: s.launchOptions,
      LastPlayTime: String(s.lastPlayTime),
    };

    // Build the tags sub-object
    if (s.tags.length > 0) {
      const tagsObj: VdfObject = {};
      for (let t = 0; t < s.tags.length; t++) {
        tagsObj[String(t)] = s.tags[t];
      }
      entry['tags'] = tagsObj;
    }

    entriesObj[String(i)] = entry;
  }

  const root: VdfObject = {
    shortcuts: entriesObj,
  };

  const buffer = serializeBinaryVdf(root);
  fs.writeFileSync(shortcutsPath, buffer);
}

/** Safely extract a string from a VdfValue. */
function str(val: unknown): string {
  if (typeof val === 'string') return val;
  return '';
}
