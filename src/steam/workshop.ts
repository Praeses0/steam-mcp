import fs from 'node:fs';
import path from 'node:path';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';
import { getLibraryFolders } from './paths.js';
import type { WorkshopItem } from './types.js';

/**
 * Parse a single appworkshop_*.acf file.
 *
 * @param workshopPath - Absolute path to the appworkshop_*.acf file.
 * @returns An object containing the appid, total size on disk, and individual workshop items.
 */
export function readWorkshopManifest(
  workshopPath: string,
): { appid: number; sizeOnDisk: number; items: WorkshopItem[] } {
  const content = fs.readFileSync(workshopPath, 'utf-8');
  const parsed = parseVdf(content);

  const state = (parsed['AppWorkshop'] ?? parsed['appworkshop'] ?? parsed) as VdfObject;

  const appid = parseInt(str(state['appid']), 10);
  const sizeOnDisk = parseInt(str(state['SizeOnDisk'] ?? state['sizeondisk'] ?? '0'), 10);

  const items: WorkshopItem[] = [];

  // Workshop items are under "WorkshopItemsInstalled" or "WorkshopItemDetails"
  const installedItems = (state['WorkshopItemsInstalled'] ??
    state['workshopitemsinstalled']) as VdfObject | undefined;

  const itemDetails = (state['WorkshopItemDetails'] ??
    state['workshopitemdetails']) as VdfObject | undefined;

  // Merge information from both sections
  const allItemIds = new Set<string>();

  if (installedItems && typeof installedItems === 'object') {
    for (const id of Object.keys(installedItems)) {
      allItemIds.add(id);
    }
  }

  if (itemDetails && typeof itemDetails === 'object') {
    for (const id of Object.keys(itemDetails)) {
      allItemIds.add(id);
    }
  }

  for (const publishedFileId of allItemIds) {
    let size = 0;
    let timeUpdated = 0;

    // Try to get size from installed items
    if (installedItems && typeof installedItems === 'object') {
      const installed = installedItems[publishedFileId];
      if (installed && typeof installed === 'object') {
        const obj = installed as VdfObject;
        size = parseInt(str(obj['size'] ?? obj['Size'] ?? '0'), 10);
        timeUpdated = parseInt(str(obj['timeupdated'] ?? obj['TimeUpdated'] ?? '0'), 10);
      }
    }

    // Override with detail info if available
    if (itemDetails && typeof itemDetails === 'object') {
      const detail = itemDetails[publishedFileId];
      if (detail && typeof detail === 'object') {
        const obj = detail as VdfObject;
        if (obj['timetouched'] || obj['timeupdated']) {
          timeUpdated = parseInt(
            str(obj['timeupdated'] ?? obj['timetouched'] ?? '0'),
            10,
          );
        }
      }
    }

    items.push({
      publishedFileId,
      appid,
      size,
      timeUpdated,
    });
  }

  return { appid, sizeOnDisk, items };
}

/**
 * Read all workshop manifests across all library folders.
 *
 * @returns A Map keyed by appid, with values containing sizeOnDisk and items.
 */
export function readAllWorkshopData(): Map<number, { sizeOnDisk: number; items: WorkshopItem[] }> {
  const folders = getLibraryFolders();
  const result = new Map<number, { sizeOnDisk: number; items: WorkshopItem[] }>();

  for (const folder of folders) {
    const workshopDir = path.join(folder, 'steamapps', 'workshop');

    if (!fs.existsSync(workshopDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(workshopDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith('appworkshop_') || !entry.endsWith('.acf')) {
        continue;
      }

      const workshopPath = path.join(workshopDir, entry);
      try {
        const data = readWorkshopManifest(workshopPath);
        result.set(data.appid, {
          sizeOnDisk: data.sizeOnDisk,
          items: data.items,
        });
      } catch (err) {
        console.warn(`Failed to parse workshop manifest ${workshopPath}: ${err}`);
      }
    }
  }

  return result;
}

/** Safely extract a string from a VdfValue. */
function str(val: unknown): string {
  if (typeof val === 'string') return val;
  return '';
}
