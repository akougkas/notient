/**
 * Formats a timestamp or Date into a human-readable relative time string.
 * @param time - Either a Date object or Unix timestamp in milliseconds
 * @returns A string like "just now", "2m ago", "1h ago", "3d ago", etc.
 */
export function formatTimeAgo(time: Date | number): string {
  const timestamp = time instanceof Date ? time.getTime() : time;
  const ms = Date.now() - timestamp;
  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Truncates a string to a maximum length, adding ellipsis if needed.
 * @param str - The string to truncate
 * @param maxLength - Maximum length before truncation
 * @returns The truncated string with "..." suffix if it exceeded maxLength
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}...`;
}

/**
 * Truncates a file path intelligently, preserving the last path segments.
 * @param path - The file path to truncate
 * @param maxLength - Maximum length before truncation (default: 40)
 * @returns The truncated path, showing ".../" prefix with last 2 segments
 */
export function truncatePath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return path.slice(0, maxLength) + "...";
  return `.../${parts.slice(-2).join("/")}`;
}
