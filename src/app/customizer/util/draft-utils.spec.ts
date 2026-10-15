import toteJson from '../../../../public/data/tote-photo.json';
import { ProductConfig } from '../models/product.models';
import { upgradeV1 } from './config-upgrade';
import { activeFields, resolveProduct } from './resolve';
import { validateConfig } from './config-validator';
import { buildCustomization, defaultValues, parseCustomization, stableKey } from './draft-utils';
import { resolveBase } from './url-policy';

function load(json: unknown): ProductConfig {
  const result = validateConfig(JSON.parse(JSON.stringify(json)), {
    resolvedBase: resolveBase({
      configUrl: 'https://shop.example/c/data/x.json',
      baseUrl: null,
      documentBase: 'https://shop.example/',
    }),
    policy: { pageOrigin: 'https://shop.example', allowedOrigins: [] },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return upgradeV1(result.config);
}

const config = load(toteJson);

/** Version-1 sources keep emitting the version-1 snapshot (the compatibility path). */
const build = (
  c: ProductConfig,
  values: Parameters<typeof defaultValues>[0] extends never ? never : Record<string, any>,
) => {
  const resolved = resolveProduct(c, null);
  return buildCustomization(c, 1, resolved, activeFields(c, resolved, values), {
    variantId: resolved.variant.id,
    artworkSelection: {},
    values,
  });
};
const parse = (raw: unknown, c: ProductConfig) => parseCustomization(raw, c, 1);

const saved = () => ({
  schemaVersion: 1,
  productId: 'tote-001',
  templateId: 'tote-name-photo',
  templateVersion: 1,
  values: {
    name: { text: 'Alex', fontId: 'serif', color: '#111827' },
    photo: { assetId: 'asset-9', crop: [0.1, 0, 0.8, 1] },
    motif: { choiceId: 'moon' },
  },
});

describe('defaultValues', () => {
  it('uses template defaults and leaves optional fields empty', () => {
    expect(defaultValues(config)).toEqual({
      name: { text: '', fontId: 'sans', color: '#296FD7' },
      photo: { assetId: null, crop: null },
      motif: { choiceId: null },
    });
  });
});

describe('buildCustomization (JSON snapshot)', () => {
  const values = {
    ...defaultValues(config),
    name: { text: 'e\u{301}lan', fontId: 'sans', color: '#296FD7' },
  };

  it('has the documented shape with NFC text and a non-authoritative price snapshot', () => {
    const json = build(config, values);
    expect(json).toMatchObject({
      schemaVersion: 1,
      productId: 'tote-001',
      variantId: 'natural',
      templateId: 'tote-name-photo',
      templateVersion: 1,
      canvas: { width: 1200, height: 1200, background: 'transparent' },
      print: { widthMm: 203.2, heightMm: 203.2 },
      displayPrice: {
        currency: 'INR',
        exponent: 2,
        baseMinor: 49900,
        customizationFeeMinor: 10000,
        totalMinor: 59900,
        authoritative: false,
      },
    });
    expect((json.values['name'] as { text: string }).text).toBe('élan');
  });

  it('is plain serialisable data: no blobs, DOM nodes or functions', () => {
    const json = build(config, {
      ...values,
      photo: { assetId: 'local-1', crop: [0, 0, 1, 1] },
    });
    const text = JSON.stringify(json);
    expect(text).not.toContain('blob:');
    expect(JSON.parse(text)).toEqual(json);
  });

  it('does not alias the draft: later edits cannot change an emitted snapshot', () => {
    const crop: [number, number, number, number] = [0, 0, 1, 1];
    const json = build(config, { ...values, photo: { assetId: 'a', crop } });
    crop[2] = 0.5;
    expect((json.values['photo'] as unknown as { crop: number[] }).crop).toEqual([0, 0, 1, 1]);
  });
});

describe('parseCustomization (F11)', () => {
  it('accepts a matching saved draft', () => {
    const result = parse(saved(), config);
    expect(result).toMatchObject({
      ok: true,
      values: {
        name: { text: 'Alex', fontId: 'serif', color: '#111827' },
        photo: { assetId: 'asset-9', crop: [0.1, 0, 0.8, 1] },
        motif: { choiceId: 'moon' },
      },
    });
  });

  it('fills fields the draft omits with template defaults', () => {
    const draft = saved();
    delete (draft.values as Record<string, unknown>)['motif'];
    const result = parse(draft, config);
    expect(result.ok && result.values['motif']).toEqual({ choiceId: null });
  });

  it.each([
    ['product', (d: any) => (d.productId = 'other')],
    ['template', (d: any) => (d.templateId = 'other')],
    ['template version', (d: any) => (d.templateVersion = 2)],
    ['schema version', (d: any) => (d.schemaVersion = 3)],
    ['unknown field', (d: any) => (d.values.ghost = { text: 'x' })],
    ['font not allowed', (d: any) => (d.values.name.fontId = 'comic')],
    ['colour not allowed', (d: any) => (d.values.name.color = '#ff00ff')],
    ['unknown artwork', (d: any) => (d.values.motif.choiceId = 'dragon')],
    ['crop without asset', (d: any) => (d.values.photo.assetId = null)],
    ['crop out of range', (d: any) => (d.values.photo.crop = [0.5, 0, 0.9, 1])],
    ['not an object', (d: any) => Object.keys(d).forEach((k) => delete d[k])],
  ])('rejects a mismatching draft: %s', (_label, mutate) => {
    const draft: any = saved();
    mutate(draft);
    expect(parse(draft, config).ok).toBe(false);
  });

  it.each([null, undefined, 'draft', 7, []])('rejects %j without throwing', (bad) => {
    expect(parse(bad, config).ok).toBe(false);
  });

  it('survives a JSON round trip of its own output', () => {
    const json = build(
      config,
      parse(saved(), config).ok ? (parse(saved(), config) as { values: any }).values : {},
    );
    expect(parse(JSON.parse(JSON.stringify(json)), config).ok).toBe(true);
  });
});

describe('stableKey', () => {
  it('ignores key order', () => {
    expect(stableKey({ a: 1, b: { c: 2, d: 3 } })).toBe(stableKey({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('distinguishes values and keeps array order', () => {
    expect(stableKey({ a: [1, 2] })).not.toBe(stableKey({ a: [2, 1] }));
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
  });
});
