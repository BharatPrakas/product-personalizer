/**
 * Byte-level checks for uploaded images, run before any decode: the declared type is not
 * trusted, dimensions are read from the headers (so a decompression bomb is refused before it is
 * decoded), and animated PNG (APNG) is detected.
 */

export type ImageSniff =
  | {
      ok: true;
      mimeType: 'image/png' | 'image/jpeg';
      width: number;
      height: number;
      animated: boolean;
    }
  | { ok: false; reason: 'unsupported-type' | 'corrupt' };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const u16 = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1];
const fourCC = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

export function sniffImage(bytes: Uint8Array): ImageSniff {
  if (startsWith(bytes, PNG_SIGNATURE)) return sniffPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return sniffJpeg(bytes);
  return { ok: false, reason: 'unsupported-type' };
}

function sniffPng(bytes: Uint8Array): ImageSniff {
  let pos = 8;
  let width = 0;
  let height = 0;
  let animated = false;
  let sawHeader = false;
  while (pos + 8 <= bytes.length) {
    const length = u32(bytes, pos);
    const type = fourCC(bytes, pos + 4);
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13 || pos + 8 + 13 > bytes.length)
        return { ok: false, reason: 'corrupt' };
      width = u32(bytes, pos + 8);
      height = u32(bytes, pos + 12);
      sawHeader = true;
    } else if (type === 'acTL') {
      animated = true;
    } else if (type === 'IDAT' || type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!sawHeader || width === 0 || height === 0) return { ok: false, reason: 'corrupt' };
  return { ok: true, mimeType: 'image/png', width, height, animated };
}

function sniffJpeg(bytes: Uint8Array): ImageSniff {
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return { ok: false, reason: 'corrupt' };
    let marker = bytes[pos + 1];
    while (marker === 0xff && pos + 2 < bytes.length) {
      pos++;
      marker = bytes[pos + 1];
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan: no frame header found
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }
    const length = u16(bytes, pos + 2);
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (pos + 9 > bytes.length) return { ok: false, reason: 'corrupt' };
      const height = u16(bytes, pos + 5);
      const width = u16(bytes, pos + 7);
      if (width === 0 || height === 0) return { ok: false, reason: 'corrupt' };
      return { ok: true, mimeType: 'image/jpeg', width, height, animated: false };
    }
    pos += 2 + length;
  }
  return { ok: false, reason: 'corrupt' };
}
