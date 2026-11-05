import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/shared/image-sniff';
import { sniffFont } from '../src/shared/font-sniff';
import { assetKeyPrefix, generateObjectKey } from '../src/storage/object-storage';
import { verifyJwtHs256, scopesFromClaims } from '../src/shared/jwt';
import { validateProductConfig, CONFIG_LIMITS } from '../src/modules/personalization/validation';
import { tinyPng, tinyFont, sampleDraft } from './helpers';

describe('image-sniff', () => {
  it('detects a PNG from its bytes and reads dimensions', () => {
    const result = sniffImage(tinyPng());
    expect(result.ok).toBe(true);
    expect(result.type).toBe('image/png');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it('rejects non-image bytes (does not trust a declared MIME type)', () => {
    const notAnImage = new TextEncoder().encode('GIF89a-ish text but not really an accepted format');
    expect(sniffImage(notAnImage).ok).toBe(false);
  });
});

describe('font-sniff', () => {
  it.each([
    ['woff2', 'font/woff2'],
    ['woff', 'font/woff'],
    ['ttf', 'font/ttf'],
    ['otf', 'font/otf'],
  ] as const)('detects %s from its bytes', (format, type) => {
    const result = sniffFont(tinyFont(format));
    expect(result.ok).toBe(true);
    expect(result.type).toBe(type);
  });

  it('detects the legacy Mac TTF tags too', () => {
    expect(sniffFont(new Uint8Array([0x74, 0x72, 0x75, 0x65, 0, 0])).type).toBe('font/ttf'); // 'true'
    expect(sniffFont(new Uint8Array([0x74, 0x79, 0x70, 0x31, 0, 0])).type).toBe('font/ttf'); // 'typ1'
  });

  it('rejects non-font bytes and a font collection (ttcf)', () => {
    expect(sniffFont(new TextEncoder().encode('not a font at all')).ok).toBe(false);
    expect(sniffFont(new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 0])).ok).toBe(false); // 'ttcf'
    expect(sniffFont(new Uint8Array([0x00, 0x01, 0x00])).ok).toBe(false); // too short
  });

  it('does not accept an image as a font, or vice versa', () => {
    expect(sniffFont(tinyPng()).ok).toBe(false);
    expect(sniffImage(tinyFont('woff2')).ok).toBe(false);
  });
});

describe('object key generation', () => {
  it('lays assets out as stores/<store>/product-personalization/assets/<uuid>.<ext>', () => {
    const a = generateObjectKey({ storeId: 'store_x', type: 'image/png' });
    const b = generateObjectKey({ storeId: 'store_x', type: 'image/png' });
    expect(a).toMatch(/^stores\/store_x\/product-personalization\/assets\/[0-9a-f-]{36}\.png$/);
    expect(a).not.toEqual(b);
    expect(a.startsWith(assetKeyPrefix('store_x'))).toBe(true);
  });

  it('gives a font the right extension', () => {
    const key = generateObjectKey({ storeId: 'store_x', type: 'font/woff2' });
    expect(key).toMatch(/\.woff2$/);
  });

  it('keeps two stores in separate prefixes', () => {
    const key = generateObjectKey({ storeId: 'store_x', type: 'image/jpeg' });
    expect(key.startsWith(assetKeyPrefix('store_x'))).toBe(true);
    expect(key.startsWith(assetKeyPrefix('store_y'))).toBe(false);
  });

  it('sanitizes a hostile store id so it cannot climb the tree', () => {
    const key = generateObjectKey({ storeId: '../../etc/passwd', type: 'image/jpeg' });
    expect(key.startsWith('stores/')).toBe(true);
    expect(key.includes('..')).toBe(false);
    expect(key.includes('/etc/')).toBe(false);
  });
});

describe('jwt verification', () => {
  async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const body = enc(payload);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
    const sigB64 = Buffer.from(new Uint8Array(sig)).toString('base64url');
    return `${header}.${body}.${sigB64}`;
  }

  it('accepts a correctly signed token and extracts claims', async () => {
    const token = await sign({ store_id: 'store_1', sub: 'user_9', scope: 'configs:write assets:write' }, 'secret');
    const result = await verifyJwtHs256(token, 'secret');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.store_id).toBe('store_1');
      expect(scopesFromClaims(result.claims)).toEqual(['configs:write', 'assets:write']);
    }
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await sign({ store_id: 'store_1' }, 'secret');
    const result = await verifyJwtHs256(token, 'other-secret');
    expect(result.ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await sign({ store_id: 'store_1', exp: 1 }, 'secret');
    const result = await verifyJwtHs256(token, 'secret');
    expect(result.ok).toBe(false);
  });
});

describe('config validation', () => {
  it('accepts a minimal valid v2 draft', () => {
    expect(validateProductConfig(sampleDraft()).ok).toBe(true);
  });

  it('preserves unknown forward-compatible fields (does not mutate input)', () => {
    const draft = sampleDraft({ futureField: { nested: true } });
    const result = validateProductConfig(draft);
    expect(result.ok).toBe(true);
    // The validator reads but never reshapes the input.
    expect((draft as Record<string, unknown>).futureField).toEqual({ nested: true });
  });

  it('flags a missing product name', () => {
    const result = validateProductConfig(sampleDraft({ product: { id: 'p' } }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'product.name')).toBe(true);
  });

  it('rejects too many mockups', () => {
    const mockups = Array.from({ length: CONFIG_LIMITS.maxMockups + 1 }, (_, i) => ({ id: `m${i}` }));
    const result = validateProductConfig(sampleDraft({ mockups }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'too_many')).toBe(true);
  });
});
