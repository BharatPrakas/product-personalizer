import { sniffImage } from './image-sniff';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]) => [
  ...be32(data.length),
  ...ascii(type),
  ...data,
  0,
  0,
  0,
  0,
];

function png(width: number, height: number, extra: number[][] = []): Uint8Array {
  const ihdr = chunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]);
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...ihdr,
    ...extra.flat(),
    ...chunk('IDAT', [0]),
    ...chunk('IEND', []),
  ]);
}

function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [
    0xff,
    sof,
    0x00,
    0x11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xda, 0, 0, 0xff, 0xd9]);
}

describe('sniffImage (F04)', () => {
  it('reads PNG dimensions from the header', () => {
    expect(sniffImage(png(1800, 1200))).toEqual({
      ok: true,
      mimeType: 'image/png',
      width: 1800,
      height: 1200,
      animated: false,
    });
  });

  it('reads JPEG dimensions from the frame header, past other segments', () => {
    expect(sniffImage(jpeg(4000, 3000))).toEqual({
      ok: true,
      mimeType: 'image/jpeg',
      width: 4000,
      height: 3000,
      animated: false,
    });
    expect(sniffImage(jpeg(640, 480, 0xc2))).toMatchObject({ ok: true, width: 640, height: 480 }); // progressive
  });

  it('detects animated PNG (acTL before the image data)', () => {
    const apng = png(10, 10, [chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])]);
    expect(sniffImage(apng)).toMatchObject({ ok: true, animated: true });
  });

  it('does not mistake a plain PNG for animated', () => {
    expect(sniffImage(png(10, 10, [chunk('tEXt', ascii('hi'))]))).toMatchObject({
      animated: false,
    });
  });

  it('rejects files that only claim to be images (fake type)', () => {
    expect(sniffImage(new TextEncoder().encode('<html>not an image.png</html>'))).toEqual({
      ok: false,
      reason: 'unsupported-type',
    });
    expect(sniffImage(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toEqual({
      ok: false,
      reason: 'unsupported-type',
    }); // GIF
    expect(sniffImage(new Uint8Array())).toEqual({ ok: false, reason: 'unsupported-type' });
  });

  it('rejects truncated or corrupt headers', () => {
    expect(sniffImage(png(10, 10).slice(0, 20))).toEqual({ ok: false, reason: 'corrupt' });
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(sniffImage(png(0, 10))).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('reports huge dimensions so the caller can refuse before decoding', () => {
    expect(sniffImage(png(60000, 60000))).toMatchObject({ ok: true, width: 60000, height: 60000 });
  });
});
