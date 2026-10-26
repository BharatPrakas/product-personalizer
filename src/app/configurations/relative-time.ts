import type { I18n } from '../admin/i18n/i18n.service';

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const formatters = new Map<string, Intl.RelativeTimeFormat>();

function formatterFor(tag: string): Intl.RelativeTimeFormat {
  let formatter = formatters.get(tag);
  if (!formatter) {
    try {
      formatter = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
    } catch {
      formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    }
    formatters.set(tag, formatter);
  }
  return formatter;
}

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago" in the locale of `i18n`. */
export function relativeTime(timestamp: number, now: number, i18n: I18n): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 45) return i18n.t('common.just-now');
  const formatter = formatterFor(i18n.tag());
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds / 60), 'minute');
}
