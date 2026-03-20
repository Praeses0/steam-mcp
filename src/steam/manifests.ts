import fs from 'node:fs';
import path from 'node:path';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import { FileCache } from '../util/cache.js';
import { getLibraryFolders } from './paths.js';
import type { AppManifest } from './types.js';

const manifestCache = new FileCache<AppManifest>();

/**
 * Parse a single appmanifest_*.acf file into an AppManifest.
 *
 * @param manifestPath - Absolute path to the .acf file.
 * @returns The parsed AppManifest.
 */
export function readManifest(manifestPath: string): AppManifest {
  const libraryPath = path.dirname(path.dirname(manifestPath));

  return manifestCache.get(manifestPath, (content: string) => {
    const parsed = parseVdf(content);
    const state = (parsed['AppState'] ?? parsed['appstate'] ?? parsed) as VdfObject;

    return {
      appid: parseInt(str(state['appid']), 10),
      name: str(state['name']),
      installdir: str(state['installdir']),
      sizeOnDisk: parseInt(str(state['SizeOnDisk'] ?? state['sizeondisk'] ?? '0'), 10),
      buildid: str(state['buildid']),
      lastUpdated: parseInt(str(state['LastUpdated'] ?? state['lastupdated'] ?? '0'), 10),
      lastPlayed: parseInt(str(state['LastPlayed'] ?? state['lastplayed'] ?? '0'), 10),
      stateFlags: parseInt(str(state['StateFlags'] ?? state['stateflags'] ?? '0'), 10),
      libraryPath,
    };
  });
}

/**
 * Read all appmanifest_*.acf files across every library folder.
 *
 * Gracefully skips library folders that are missing or unmounted.
 *
 * @returns Array of all parsed AppManifest objects.
 */
export function readAllManifests(): AppManifest[] {
  const folders = getLibraryFolders();
  const manifests: AppManifest[] = [];

  for (const folder of folders) {
    const steamapps = path.join(folder, 'steamapps');

    if (!fs.existsSync(steamapps)) {
      console.warn(`Library folder not accessible, skipping: ${steamapps}`);
      continue;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(steamapps);
    } catch (err) {
      console.warn(`Failed to read library folder ${steamapps}: ${err}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith('appmanifest_') || !entry.endsWith('.acf')) {
        continue;
      }

      const manifestPath = path.join(steamapps, entry);
      try {
        manifests.push(readManifest(manifestPath));
      } catch (err) {
        console.warn(`Failed to parse manifest ${manifestPath}: ${err}`);
      }
    }
  }

  return manifests;
}

/** Safely extract a string from a VdfValue. */
function str(val: unknown): string {
  if (typeof val === 'string') return val;
  return '';
}
