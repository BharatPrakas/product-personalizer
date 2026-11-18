import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/shared/image-sniff';
import { sniffFont } from '../src/shared/font-sniff';
import { assetKeyPrefix, generateObjectKey } from '../src/storage/object-storage';
import { verifyJwtHs256 } from '../src/shared/jwt';
import { pluginIdFromClaims, storeIdFromClaims } from '../src/middleware/authentication';
import { loadConfig, type Env } from '../src/config/environment';
import { signAsset, verifyAssetSignature } from '../src/modules/personalization/asset-signature';
import { validateProductConfig, CONFIG_LIMITS } from '../src/modules/personalization/validation';
import { TEST_PLUGIN_SECRET, tinyPng, tinyFont, sampleDraft } from './helpers';

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
  const NOW = Math.floor(Date.now() / 1000);
  const FUTURE = NOW + 600;

  async function sign(
    payload: Record<string, unknown>,
    key: string,
    header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
  ): Promise<string> {
    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');
    const head = enc(header);
    const body = enc(payload);
    const hmac = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${head}.${body}`));
    const sigB64 = Buffer.from(new Uint8Array(sig)).toString('base64url');
    return `${head}.${body}.${sigB64}`;
  }

  it('accepts a correctly signed token and extracts claims', async () => {
    const token = await sign({ storeId: 766, pluginId: 160, sub: 'user_9', iat: NOW, exp: FUTURE }, 'secret');
    const result = await verifyJwtHs256(token, 'secret');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toMatchObject({ storeId: 766, pluginId: 160, sub: 'user_9', iat: NOW, exp: FUTURE });
    }
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await sign({ storeId: 1, iat: NOW, exp: FUTURE }, 'secret');
    const result = await verifyJwtHs256(token, 'other-secret');
    expect(result).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects an expired token', async () => {
    const token = await sign({ storeId: 1, iat: 1, exp: 2 }, 'secret');
    const result = await verifyJwtHs256(token, 'secret');
    expect(result).toEqual({ ok: false, reason: 'token expired' });
  });

  it('rejects a token with no expiry, or one that is not a number — a bearer token must be short-lived', async () => {
    for (const exp of [undefined, null, '9999999999', Number.NaN]) {
      const token = await sign({ storeId: 1, iat: NOW, ...(exp === undefined ? {} : { exp }) }, 'secret');
      expect(await verifyJwtHs256(token, 'secret'), String(exp)).toEqual({ ok: false, reason: 'token has no expiry' });
    }
  });

  it('rejects a token with no issue time (iat is required), or one that is not a number', async () => {
    for (const iat of [undefined, null, String(NOW)]) {
      const token = await sign({ storeId: 1, exp: FUTURE, ...(iat === undefined ? {} : { iat }) }, 'secret');
      expect(await verifyJwtHs256(token, 'secret'), String(iat)).toEqual({ ok: false, reason: 'token has no issue time' });
    }
  });

  it('honours nbf', async () => {
    const token = await sign({ storeId: 1, iat: NOW, exp: FUTURE, nbf: FUTURE - 300 }, 'secret');
    expect(await verifyJwtHs256(token, 'secret')).toEqual({ ok: false, reason: 'token not yet valid' });
  });

  it('accepts only alg HS256: none, HS384, RS256 and a missing alg are refused even with a matching MAC', async () => {
    for (const alg of ['none', 'HS384', 'RS256', 'hs256', undefined]) {
      const token = await sign({ storeId: 1, iat: NOW, exp: FUTURE }, 'secret', alg === undefined ? { typ: 'JWT' } : { alg, typ: 'JWT' });
      expect(await verifyJwtHs256(token, 'secret'), String(alg)).toEqual({ ok: false, reason: 'unsupported algorithm' });
    }
    // An unsigned token (empty signature part) is simply a bad signature, never an accepted one.
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"iat":1,"exp":9999999999,"storeId":1}').toString('base64url')}.`;
    expect((await verifyJwtHs256(unsigned, 'secret')).ok).toBe(false);
  });

  it('answers malformed input with a rejection, never an exception', async () => {
    for (const token of ['', 'a.b', 'a.b.c.d', 'not a token', '%%%.%%%.%%%', `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.e30.@@@`]) {
      expect((await verifyJwtHs256(token, 'secret')).ok, token).toBe(false);
    }
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

describe('store id claim', () => {
  it.each([
    [{ storeId: 766 }, '766'],
    [{ storeId: '766' }, '766'],
    [{ storeId: 'store_1' }, 'store_1'],
  ])('reads %j as %s', (claims, expected) => {
    expect(storeIdFromClaims(claims)).toBe(expected);
  });

  it.each([
    {}, { storeId: '' }, { storeId: 0 }, { storeId: -3 }, { storeId: 1.5 }, { storeId: 2 ** 60 }, { storeId: null },
    { storeId: { id: 1 } },
    // The legacy snake_case alias is not part of the contract any more.
    { store_id: 'store_1' }, { store_id: 766 },
  ])('rejects %j', (claims) => {
    expect(storeIdFromClaims(claims as never)).toBeNull();
  });
});

describe('plugin id claim', () => {
  it.each([
    [{ pluginId: 160 }, '160'],
    [{ pluginId: '160' }, '160'],
  ])('reads %j as %s', (claims, expected) => {
    expect(pluginIdFromClaims(claims)).toBe(expected);
  });

  it.each([{}, { pluginId: '' }, { pluginId: 0 }, { pluginId: -3 }, { pluginId: 1.5 }, { pluginId: null }, { pluginId: { id: 1 } }, { pluginId: [160] }])(
    'rejects %j',
    (claims) => {
      expect(pluginIdFromClaims(claims as never)).toBeNull();
    },
  );
});

describe('which secret signs asset URLs (independent of every authentication secret)', () => {
  const config = (vars: Record<string, string | undefined>) => loadConfig({ ...vars } as unknown as Env).assetSigningSecret;

  it('uses ASSET_SIGNING_SECRET and nothing else', () => {
    expect(config({ ASSET_SIGNING_SECRET: 'asset-key' })).toBe('asset-key');
    expect(config({ ASSET_SIGNING_SECRET: '  asset-key ' })).toBe('asset-key');
    expect(config({})).toBeNull();
  });

  it('has NO fallback: the legacy JWT_SIGNING_SECRET and the plugin secret never sign asset URLs', () => {
    expect(config({ JWT_SIGNING_SECRET: 'legacy' })).toBeNull();
    expect(config({ ZB_PLUGIN_SECRET: TEST_PLUGIN_SECRET })).toBeNull();
    expect(config({ ASSET_SIGNING_SECRET: 'asset-key', JWT_SIGNING_SECRET: 'legacy', ZB_PLUGIN_SECRET: TEST_PLUGIN_SECRET })).toBe('asset-key');
  });

  it('a signature only verifies under the key that made it', () => {
    const sig = signAsset('asset-key', 'store_a', 'ASSET-1');
    expect(verifyAssetSignature('asset-key', 'store_a', 'asset-1', sig)).toBe(true);
    expect(verifyAssetSignature(TEST_PLUGIN_SECRET, 'store_a', 'asset-1', sig)).toBe(false);
    expect(verifyAssetSignature('legacy', 'store_a', 'asset-1', sig)).toBe(false);
  });
});

describe('plugin configuration parsing', () => {
  const parse = (vars: Record<string, string | undefined>) => loadConfig({ ...vars } as unknown as Env);

  it('treats a missing or too-short secret as not configured (fail closed), and trims a good one', () => {
    expect(parse({}).zbPluginSecret).toBeNull();
    expect(parse({ ZB_PLUGIN_SECRET: 'short' }).zbPluginSecret).toBeNull();
    expect(parse({ ZB_PLUGIN_SECRET: `  ${TEST_PLUGIN_SECRET} ` }).zbPluginSecret).toBe(TEST_PLUGIN_SECRET);
  });

  it('reads the plugin id, trimmed, and treats blank as not configured', () => {
    expect(parse({ ZB_PLUGIN_ID: ' 160 ' }).zbPluginId).toBe('160');
    expect(parse({ ZB_PLUGIN_ID: '   ' }).zbPluginId).toBeNull();
    expect(parse({}).zbPluginId).toBeNull();
  });

  it('exposes no setting for any retired mechanism', () => {
    const keys = Object.keys(
      parse({
        DEV_AUTH_TOKEN: 'x', DEV_STORE_ID: 'x', DEV_AUTH_BYPASS: 'true', JWT_SIGNING_SECRET: 'x',
        ZB_PLUGIN_SECRET_PREVIOUS: 'x'.repeat(40), ZB_JWT_KEY_MODE: 'derived', INTEGRATION_ENCRYPTION_KEY: 'x',
        CUSTOMIZATION_TOKEN_SECRET: 'x',
      }),
    );
    expect(keys.filter((k) => /dev|jwt|previous|encryption|customizationToken|keyMode|integration/i.test(k))).toEqual([]);
  });
});
