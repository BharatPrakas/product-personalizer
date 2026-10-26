import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore, RateLimiter } from '../src/shared/rate-limit';
import { decodeCursor, encodeCursor } from '../src/plugins/personalization/pagination';
import { normalizeOrigin, originsFromSettings } from '../src/plugins/personalization/settings-service';
import {
  classifyReference,
  collectAssetLocators,
  rewriteAssetReferences,
  type AssetIndex,
} from '../src/plugins/personalization/storefront-assets';
import { etagMatches, storefrontCorsHeaders } from '../src/plugins/personalization/storefront-controller';
import { validateMarkupPayload } from '../src/plugins/personalization/validation';
import type { ProductConfigLike } from '../src/plugins/personalization/types';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_FOREIGN = '33333333-3333-4333-8333-333333333333';
const OPTS = { apiVersion: 'v1', assetPublicBaseUrl: null, publicOrigin: 'https://api.example.com' };
const admin = (id: string, origin = 'https://api.example.com') =>
  `${origin}/api/v1/plugins/personalization/assets/${id}/content`;
const pub = (id: string) => `https://api.example.com/api/v1/storefront/personalization/assets/${id}`;

const index = (ids: string[], keys: Record<string, string> = {}): AssetIndex => ({
  ids: new Set(ids),
  idByKey: new Map(Object.entries(keys)),
});

/** Mirrors the strict v2 validator's URL rule: absolute http(s), no credentials, no local schemes. */
function isAbsoluteHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sampleConfig(): ProductConfigLike {
  return {
    schemaVersion: 2,
    id: 'cfg-x',
    version: 3,
    status: 'published',
    product: { id: 'p', name: 'Tee' },
    assetBaseUrl: 'https://cdn.example.com/base/',
    variants: [],
    mockups: [
      {
        id: 'm1',
        name: 'Front',
        src: admin(ID_A),
        thumbnail: admin(ID_B, 'http://localhost:8787'),
        placements: [],
        overlays: [{ id: 'o1', src: 'overlays/shine.png' }],
      },
    ],
    printableAreas: [],
    artworks: [
      {
        id: 'a1',
        name: 'Art',
        printableAreaId: 'x',
        layers: [
          { id: 'l1', type: 'fixed-image', src: 'https://other.example/logo.png' },
          { id: 'l2', type: 'text', text: 'src: idb:not-a-reference', fontSize: 10, minFontSize: 5, align: 'left' },
        ],
      },
    ],
    fonts: [{ id: 'f1', family: 'Brand', src: 'fonts/brand.woff2' }],
    fields: [
      {
        id: 'fld',
        type: 'artwork',
        label: 'Clipart',
        required: false,
        choices: [{ id: 'c1', label: 'Star', src: admin(ID_A), thumbnailSrc: 'star-thumb.png' }],
      },
    ],
  };
}

describe('asset reference classification', () => {
  it('recognises Worker delivery URLs from any origin and the storefront URL itself', () => {
    expect(classifyReference(admin(ID_A), undefined, OPTS)).toEqual({ kind: 'asset-id', id: ID_A });
    expect(classifyReference(admin(ID_A, 'http://localhost:8787'), undefined, OPTS)).toEqual({ kind: 'asset-id', id: ID_A });
    expect(classifyReference(pub(ID_A), undefined, OPTS)).toEqual({ kind: 'asset-id', id: ID_A });
    expect(classifyReference(admin(ID_A.toUpperCase()), undefined, OPTS)).toEqual({ kind: 'asset-id', id: ID_A });
  });

  it('recognises R2 custom-domain URLs by object key', () => {
    const opts = { ...OPTS, assetPublicBaseUrl: 'https://assets.example.com' };
    const key = 'stores/store_alpha/product-personalization/assets/abc.png';
    expect(classifyReference(`https://assets.example.com/${key}`, undefined, opts)).toEqual({ kind: 'asset-key', key });
    // A different host with the same path is just an external URL.
    expect(classifyReference(`https://elsewhere.example/${key}`, undefined, opts).kind).toBe('external');
  });

  it('passes through absolute external URLs and resolves relatives against an absolute base', () => {
    expect(classifyReference('https://cdn.example.com/a.png', undefined, OPTS)).toEqual({
      kind: 'external',
      url: 'https://cdn.example.com/a.png',
    });
    expect(classifyReference('a/b.png', 'https://cdn.example.com/base', OPTS)).toEqual({
      kind: 'external',
      url: 'https://cdn.example.com/base/a/b.png',
    });
  });

  it('marks everything that cannot be a public absolute http(s) URL as unresolved', () => {
    const bad = [
      'idb:abc',
      'data:image/png;base64,AAAA',
      'blob:https://x/1',
      'javascript:alert(1)',
      'ftp://x/y.png',
      'file:///etc/passwd',
      '//cdn.example.com/a.png',
      'https://user:pw@cdn.example.com/a.png',
      ' https://cdn.example.com/a.png',
      'https://cdn.example.com/a\\b.png',
      '',
      'x'.repeat(3000),
    ];
    for (const value of bad) expect(classifyReference(value, undefined, OPTS).kind, value).toBe('unresolved');
    // Relative with a relative / missing / non-http base.
    expect(classifyReference('a.png', 'assets/', OPTS).kind).toBe('unresolved');
    expect(classifyReference('a.png', undefined, OPTS).kind).toBe('unresolved');
    expect(classifyReference('a.png', 'file:///tmp/', OPTS).kind).toBe('unresolved');
  });
});

describe('rewriteAssetReferences', () => {
  it('collects only Worker-managed locators, from every reference-carrying key', () => {
    const found = collectAssetLocators(sampleConfig(), OPTS);
    expect([...found.ids].sort()).toEqual([ID_A, ID_B]);
    expect(found.keys.size).toBe(0);
  });

  it('rewrites mockups, thumbnails, overlays, layers, fonts and artwork choices to absolute http(s) URLs', () => {
    const result = rewriteAssetReferences(sampleConfig(), index([ID_A, ID_B]), OPTS);
    expect(result.unresolved).toEqual([]);
    const c = result.config as Record<string, any>;
    expect(c.mockups[0].src).toBe(pub(ID_A));
    expect(c.mockups[0].thumbnail).toBe(pub(ID_B));
    expect(c.mockups[0].overlays[0].src).toBe('https://cdn.example.com/base/overlays/shine.png');
    expect(c.artworks[0].layers[0].src).toBe('https://other.example/logo.png');
    expect(c.fonts[0].src).toBe('https://cdn.example.com/base/fonts/brand.woff2');
    expect(c.fields[0].choices[0].src).toBe(pub(ID_A));
    expect(c.fields[0].choices[0].thumbnailSrc).toBe('https://cdn.example.com/base/star-thumb.png');
    // Free text that merely looks like a reference is untouched.
    expect(c.artworks[0].layers[1].text).toBe('src: idb:not-a-reference');
    // Every reference-carrying value is now absolute http(s); assetBaseUrl is gone.
    const refs = JSON.stringify(c).match(/"(?:src|thumbnail|thumbnailSrc)":"([^"]+)"/g) ?? [];
    expect(refs.length).toBe(7);
    for (const ref of refs) expect(isAbsoluteHttp(/:"([^"]+)"$/.exec(ref)![1])).toBe(true);
    expect(c.assetBaseUrl).toBeUndefined();
    // Non-asset fields survive verbatim.
    expect(c.version).toBe(3);
    expect(c.product).toEqual({ id: 'p', name: 'Tee' });
  });

  it('does not mutate its input', () => {
    const original = sampleConfig();
    const snapshot = JSON.stringify(original);
    rewriteAssetReferences(original, index([ID_A, ID_B]), OPTS);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('reports references to assets outside the store index (cross-store / deleted) as unresolved', () => {
    const config = sampleConfig();
    (config.mockups![0] as Record<string, unknown>)['src'] = admin(ID_FOREIGN);
    const result = rewriteAssetReferences(config, index([ID_A, ID_B]), OPTS);
    expect(result.unresolved).toHaveLength(1);
    expect(admin(ID_FOREIGN).startsWith(result.unresolved[0].replace(/\.\.\.$/, ''))).toBe(true);
  });

  it('reports browser-local and relative-without-base references and truncates long values', () => {
    const config: ProductConfigLike = {
      schemaVersion: 2,
      mockups: [
        { id: 'm', src: 'idb:abc' },
        { id: 'n', src: 'data:image/png;base64,' + 'A'.repeat(500) },
        { id: 'o', src: 'rel.png' },
      ],
    };
    const result = rewriteAssetReferences(config, index([]), OPTS);
    expect(result.unresolved).toHaveLength(3);
    expect(result.unresolved.every((u) => u.length <= 80)).toBe(true);
  });

  it('maps object-key (public base) references through the index', () => {
    const opts = { ...OPTS, assetPublicBaseUrl: 'https://assets.example.com' };
    const key = 'stores/s/product-personalization/assets/x.png';
    const config: ProductConfigLike = { schemaVersion: 2, mockups: [{ id: 'm', src: `https://assets.example.com/${key}` }] };
    expect(collectAssetLocators(config, opts).keys.has(key)).toBe(true);
    const ok = rewriteAssetReferences(config, index([], { [key]: ID_A }), opts);
    expect((ok.config.mockups![0] as Record<string, unknown>)['src']).toBe(pub(ID_A));
    expect(rewriteAssetReferences(config, index([]), opts).unresolved).toHaveLength(1);
  });

  it('is idempotent: rewriting an already-rewritten config changes nothing', () => {
    const first = rewriteAssetReferences(sampleConfig(), index([ID_A, ID_B]), OPTS);
    const second = rewriteAssetReferences(first.config, index([ID_A, ID_B]), OPTS);
    expect(second.config).toEqual(first.config);
    expect(second.unresolved).toEqual([]);
  });
});

describe('fixed-window rate limiter', () => {
  it('allows up to the limit, then blocks until the window resets', async () => {
    let now = 0;
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), () => now);
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await limiter.check('k', 3, 10));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
    expect(decisions[3].retryAfterSeconds).toBe(10);
    now = 4_000;
    expect((await limiter.check('k', 3, 10)).retryAfterSeconds).toBe(6);
    now = 10_000;
    expect((await limiter.check('k', 3, 10)).allowed).toBe(true);
    expect((await limiter.check('other', 3, 10)).allowed).toBe(true);
  });

  it('keeps memory bounded', async () => {
    const store = new InMemoryRateLimitStore(100);
    const limiter = new RateLimiter(store, () => 0);
    for (let i = 0; i < 1_000; i++) await limiter.check(`k${i}`, 5, 60);
    expect(store.size).toBeLessThanOrEqual(100);
  });
});

describe('helpers', () => {
  it('etagMatches follows If-None-Match semantics', () => {
    const etag = '"abc"';
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches('"abc"', etag)).toBe(true);
    expect(etagMatches('W/"abc"', etag)).toBe(true);
    expect(etagMatches('"x", "abc"', etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('"abcd"', etag)).toBe(false);
  });

  it('storefront CORS only reflects an origin on the store list', () => {
    const store = { storeId: 's', allowedOrigins: ['https://shop.example.com'] };
    expect(storefrontCorsHeaders('https://shop.example.com', store).get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(storefrontCorsHeaders('https://SHOP.example.com', store).get('access-control-allow-origin')).toBe('https://SHOP.example.com');
    expect(storefrontCorsHeaders('https://evil.example', store).has('access-control-allow-origin')).toBe(false);
    expect(storefrontCorsHeaders('https://shop.example.com', { storeId: 's', allowedOrigins: [] }).has('access-control-allow-origin')).toBe(false);
    expect(storefrontCorsHeaders('https://shop.example.com', null).has('access-control-allow-origin')).toBe(false);
    expect(storefrontCorsHeaders(undefined, store).get('vary')).toBe('Origin');
  });

  it('cursors round-trip and reject tampering', () => {
    const cursor = { createdAtMs: 1760000000000, id: '11111111-1111-4111-8111-111111111111' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('###')).toThrow();
    expect(() => decodeCursor(btoa('1.not-a-uuid'))).toThrow();
    expect(() => decodeCursor(btoa("1.11111111-1111-4111-8111-111111111111'; DROP TABLE x"))).toThrow();
  });

  it('normalises origins and reads stored settings defensively', () => {
    expect(normalizeOrigin('https://Shop.Example.com/')).toBe('https://shop.example.com');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeOrigin('https://x.example/path')).toBeNull();
    expect(normalizeOrigin('https://x.example?q=1')).toBeNull();
    expect(normalizeOrigin('x.example')).toBeNull();
    expect(originsFromSettings({ storefrontOrigins: ['HTTPS://A.example', 5, null] })).toEqual(['https://a.example']);
    expect(originsFromSettings({ storefrontOrigins: 'nope' })).toEqual([]);
    expect(originsFromSettings(undefined)).toEqual([]);
  });

  it('validates markup payloads', () => {
    expect(validateMarkupPayload({ a: 1 }).ok).toBe(true);
    expect(validateMarkupPayload([]).ok).toBe(false);
    expect(validateMarkupPayload(null).ok).toBe(false);
    expect(validateMarkupPayload({ s: 'x'.repeat(256 * 1024) }).issues[0].code).toBe('too_large');
  });
});
