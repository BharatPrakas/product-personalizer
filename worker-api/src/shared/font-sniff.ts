/**
 * Content-based font type detection, mirroring `image-sniff.ts`: we validate the actual bytes
 * rather than trusting the browser-supplied Content-Type. Supports the formats every evergreen
 * browser's `FontFace` API accepts natively (format is auto-detected from the bytes at render
 * time, so the detected type here only has to be accurate enough for a correct HTTP response).
 */

export type DetectedFontType = 'font/woff2' | 'font/woff' | 'font/ttf' | 'font/otf';

export interface FontSniffResult {
  ok: boolean;
  type?: DetectedFontType;
}

function tag(b: Uint8Array, i: number): string {
  return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
}

/**
 * WOFF2: 'wOF2'. WOFF: 'wOFF'. TTF (sfnt v1): 0x00010000, or the legacy Mac 'true'/'typ1' tags.
 * OTF (CFF-flavoured OpenType): 'OTTO'. Collection files (.ttc/.otc, tag 'ttcf') are rejected: a
 * `FontFace` needs one font, not a collection.
 */
export function sniffFont(bytes: Uint8Array): FontSniffResult {
  if (bytes.length < 4) return { ok: false };
  const head = tag(bytes, 0);
  if (head === 'wOF2') return { ok: true, type: 'font/woff2' };
  if (head === 'wOFF') return { ok: true, type: 'font/woff' };
  if (head === 'OTTO') return { ok: true, type: 'font/otf' };
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return { ok: true, type: 'font/ttf' };
  }
  if (head === 'true' || head === 'typ1') return { ok: true, type: 'font/ttf' };
  return { ok: false };
}
