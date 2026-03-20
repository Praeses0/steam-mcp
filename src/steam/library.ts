import fs from 'node:fs';
import path from 'node:path';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import { getSteamDir } from './paths.js';
import type { LibraryFolder } from './types.js';

/**
 * Parse libraryfolders.vdf and return enriched LibraryFolder objects.
 *
 * Each folder includes:
 *   - The path from VDF
 *   - A label (if present in VDF, otherwise empty)
 *   - Total size from VDF's "totalsize" field
 *   - Free space obtained via fs.statfsSync
 *   - List of appids listed in the folder
 *   - Whether the path is currently mounted/accessible
 *
 * @returns Array of LibraryFolder objects.
 */
export function getLibraries(): LibraryFolder[] {
  const steamDir = getSteamDir();
  const vdfPath = path.join(steamDir, 'config', 'libraryfolders.vdf');
  const content = fs.readFileSync(vdfPath, 'utf-8');
  const parsed = parseVdf(content);

  const libraryfolders = (parsed['libraryfolders'] ??
    parsed['LibraryFolders']) as VdfObject | undefined;

  if (!libraryfolders || typeof libraryfolders === 'string') {
    throw new Error('No "libraryfolders" section found in libraryfolders.vdf');
  }

  const results: LibraryFolder[] = [];

  for (const [key, value] of Object.entries(libraryfolders)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof value === 'string') continue;

    const entry = value as VdfObject;
    const folderPath = entry['path'] as string | undefined;
    if (!folderPath) continue;

    // Extract appids from the "apps" sub-object
    const appsObj = entry['apps'] as VdfObject | undefined;
    const appids: number[] = [];
    if (appsObj && typeof appsObj === 'object') {
      for (const appidStr of Object.keys(appsObj)) {
        const id = parseInt(appidStr, 10);
        if (!isNaN(id)) {
          appids.push(id);
        }
      }
    }

    // Check if mounted
    const mounted = fs.existsSync(folderPath);

    // Get free space via statfsSync
    let freeSpace = 0;
    if (mounted) {
      try {
        const stat = fs.statfsSync(folderPath);
        freeSpace = stat.bfree * stat.bsize;
      } catch {
        // Cannot stat — leave freeSpace as 0
      }
    }

    const totalSize = parseInt((entry['totalsize'] ?? '0') as string, 10) || 0;
    const label = (entry['label'] ?? '') as string;

    results.push({
      path: folderPath,
      label,
      totalSize,
      freeSpace,
      appids,
      mounted,
    });
  }

  return results;
}
