/**
 * Safe names for files and folders inside download archives. Every name that goes into a ZIP comes
 * from data a shopper, a merchant or the platform typed (area names, order ids, line ids), so it is
 * treated as hostile: no path separators, no `..`, no control characters, no names Windows refuses,
 * bounded length — and no two entries of one folder may collide.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_SEGMENT = 80;

/** One path segment (a file or folder name), never empty. */
export function sanitizeSegment(name: string | null | undefined, fallback = 'file'): string {
  let out = (name ?? '')
    .normalize('NFC')
    // Control characters (incl. NUL, newlines, bidi overrides) and characters illegal on common file systems.
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // No hidden files, no `.` / `..`, no trailing dots or spaces (Windows strips them).
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (out.length > MAX_SEGMENT) out = out.slice(0, MAX_SEGMENT).trim();
  if (!out) out = sanitizeSegment(fallback, 'file');
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/** `base` + `.ext`, with the base sanitised and the extension limited to [a-z0-9]. */
export function fileName(base: string | null | undefined, extension: string, fallback = 'file'): string {
  const ext = extension.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const stem = sanitizeSegment(base, fallback).slice(0, MAX_SEGMENT - ext.length - 1);
  return ext ? `${stem}.${ext}` : stem;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/json': 'json',
  'application/pdf': 'pdf',
};

export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/**
 * Hands out names that are unique within one folder (case-insensitively, as most file systems
 * compare them): a repeat becomes `name (2).ext`, `name (3).ext`, ...
 */
export class UniqueNames {
  private readonly taken = new Set<string>();

  claim(name: string): string {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; this.taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }
}
