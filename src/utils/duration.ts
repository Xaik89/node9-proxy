// src/utils/duration.ts
// Parse human-readable duration strings into milliseconds.

/** Parse a duration string like "15m", "1h", "30s" → milliseconds, or null if invalid. */
export function parseDuration(str: string): number | null {
  const m = str.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? 'm').toLowerCase()) {
    case 's':
      return Math.round(n * 1_000);
    case 'm':
      return Math.round(n * 60_000);
    case 'h':
      return Math.round(n * 3_600_000);
    case 'd':
      return Math.round(n * 86_400_000);
    default:
      return null;
  }
}
