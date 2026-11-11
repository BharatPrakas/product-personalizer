/**
 * A minimal ZIP writer: STORE only (no compression), UTF-8 names, no ZIP64.
 *
 * Why not a library: the archives hold PNG/JPEG files that are already compressed, so deflate would
 * buy almost nothing, and this keeps the admin bundle free of a ~25-100 kB dependency for ~100 lines.
 * Readable by every common unzip tool (Windows Explorer, macOS Archive Utility, `unzip`, 7-Zip).
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive; callers sanitise every segment (see filenames.ts). */
  path: string;
  data: Uint8Array;
}

/** Hard ceiling without ZIP64 (sizes and offsets are 32-bit). */
export const MAX_ZIP_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time of `date` (local time, 2-second resolution, 1980 at the earliest). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Builds a ZIP archive. `now` stamps every entry (injectable so tests are deterministic). */
export function createZip(entries: readonly ZipEntry[], now: Date = new Date()): Blob {
  if (entries.length > MAX_ENTRIES) throw new Error('Too many files for one archive.');
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed (2.0)
    lv.setUint16(6, 0x0800, true); // flags: names are UTF-8
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 0x0314, true); // made by: Unix, spec 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk number start, internal attributes: 0
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // external attributes: regular file, rw-r--r--
    cv.setUint32(42, offset, true); // offset of the local header
    header.set(name, 46);

    parts.push(local, entry.data);
    central.push(header);
    offset += local.length + size;
    if (offset > MAX_ZIP_BYTES) throw new Error('The archive is too large.');
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries in total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  return new Blob([...parts, ...central, end] as BlobPart[], { type: 'application/zip' });
}
