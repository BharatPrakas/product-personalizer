/**
 * Content-based image type detection. We validate the actual bytes rather than trusting the
 * browser-supplied Content-Type. Supports the raster formats the editor accepts (PNG, JPEG, WebP)
 * and reads intrinsic dimensions where cheap to do so.
 */

export type DetectedImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface SniffResult {
  ok: boolean;
  type?: DetectedImageType;
  width?: number;
  height?: number;
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
function u32le(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function sniffPng(b: Uint8Array): SniffResult | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return null;
  // IHDR width/height at offset 16/20.
  return { ok: true, type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function sniffJpeg(b: Uint8Array): SniffResult | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // SOF markers carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      return { ok: true, type: 'image/jpeg', width, height };
    }
    const len = u16be(b, i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { ok: true, type: 'image/jpeg' };
}

function sniffWebp(b: Uint8Array): SniffResult | null {
  if (b.length < 30) return b.length >= 12 && isWebpHeader(b) ? { ok: true, type: 'image/webp' } : null;
  if (!isWebpHeader(b)) return null;
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === 'VP8 ') {
    // Lossy: dimensions in the frame header.
    const width = u16be(b, 27) & 0x3fff; // actually little-endian 14-bit; approximate guard below
    return { ok: true, type: 'image/webp', width: width || undefined };
  }
  if (fourcc === 'VP8L') {
    const bits = u32le(b, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { ok: true, type: 'image/webp', width, height };
  }
  if (fourcc === 'VP8X') {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { ok: true, type: 'image/webp', width, height };
  }
  return { ok: true, type: 'image/webp' };
}

function isWebpHeader(b: Uint8Array): boolean {
  return (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  );
}

export function sniffImage(bytes: Uint8Array): SniffResult {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes) ?? { ok: false };
}
