import { createZip, crc32 } from './zip';

interface Parsed {
  path: string;
  data: Uint8Array;
  crc: number;
  flags: number;
  method: number;
}

/** A strict reader for what `createZip` writes: walks the central directory and each local header. */
async function readZip(blob: Blob): Promise<Parsed[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  let pos = view.getUint32(end + 16, true);
  expect(pos + centralSize).toBe(end);
  const out: Parsed[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const local = view.getUint32(pos + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    const localName = view.getUint16(local + 26, true);
    const start = local + 30 + localName + view.getUint16(local + 28, true);
    out.push({ path, data: bytes.slice(start, start + size), crc, flags, method });
    pos += 46 + nameLength;
  }
  return out;
}

describe('createZip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes a readable store-only archive with UTF-8 names and correct checksums', async () => {
    const files = [
      { path: 'production/Front.png', data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
      { path: 'previews/Façade.png', data: new Uint8Array([9, 8, 7]) },
      { path: 'customization.json', data: new TextEncoder().encode('{"a":1}') },
      { path: 'empty.txt', data: new Uint8Array() },
    ];
    const blob = createZip(files, new Date(2026, 10, 10, 12, 30, 0));
    expect(blob.type).toBe('application/zip');
    const parsed = await readZip(blob);
    expect(parsed.map((p) => p.path)).toEqual(files.map((f) => f.path));
    parsed.forEach((p, i) => {
      expect([...p.data]).toEqual([...files[i].data]);
      expect(p.crc).toBe(crc32(files[i].data));
      expect(p.method).toBe(0);
      expect(p.flags & 0x0800).toBe(0x0800);
    });
  });

  it('writes an empty archive', async () => {
    expect(await readZip(createZip([]))).toEqual([]);
  });
});
