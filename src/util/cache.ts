import fs from 'node:fs';

/**
 * A simple file cache that uses mtime-based invalidation.
 *
 * When a file is requested, the cache checks if the file's mtime has changed
 * since the last read. If unchanged, the cached parse result is returned.
 * Otherwise the file is re-read and re-parsed.
 */
export class FileCache<T> {
  private cache = new Map<string, { mtime: number; data: T }>();

  /**
   * Get the parsed contents of a file, using the cache if the file has not
   * been modified since the last read.
   *
   * @param path   - Absolute path to the file.
   * @param parser - Function that transforms the file's text content into T.
   * @returns The parsed data.
   */
  get(path: string, parser: (content: string) => T): T {
    const stat = fs.statSync(path);
    const cached = this.cache.get(path);

    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.data;
    }

    const content = fs.readFileSync(path, 'utf-8');
    const data = parser(content);
    this.cache.set(path, { mtime: stat.mtimeMs, data });
    return data;
  }

  /**
   * Invalidate cached entries.
   *
   * @param path - If provided, invalidate only that path. Otherwise clear the entire cache.
   */
  invalidate(path?: string): void {
    if (path) {
      this.cache.delete(path);
    } else {
      this.cache.clear();
    }
  }
}
