const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds / 60), 'minute');
}

export function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}
