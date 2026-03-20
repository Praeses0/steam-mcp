/**
 * Format a byte count into a human-readable string.
 *
 * Examples: "1.23 GB", "456.78 MB", "1.00 KB", "512 B"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) bytes = 0;

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  if (unitIndex === 0) {
    return `${value} B`;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Format a playtime given in minutes into a human-readable string.
 *
 * Examples: "12.3 hours", "45 minutes", "0 minutes"
 */
export function formatPlaytime(minutes: number): string {
  if (minutes < 0) minutes = 0;

  if (minutes < 60) {
    return `${minutes} minutes`;
  }

  const hours = minutes / 60;
  return `${hours.toFixed(1)} hours`;
}

/**
 * Format a Unix timestamp (seconds since epoch) into an ISO 8601 date string.
 *
 * Returns "N/A" for zero or negative timestamps.
 */
export function formatTimestamp(unixSeconds: number): string {
  if (unixSeconds <= 0) {
    return 'N/A';
  }
  return new Date(unixSeconds * 1000).toISOString();
}
