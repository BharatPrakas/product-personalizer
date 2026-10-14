import Ajv2020 from 'ajv/dist/2020';
import posterJson from '../../../../public/data/poster-artwork.json';
import toteJson from '../../../../public/data/tote-photo.json';
import tshirtJson from '../../../../public/data/tshirt-text.json';
import schema from '../../../../public/schema/customizer-config.schema.json';
import { CustomizerConfig } from '../models/config.models';
import { ValidationResult, checkMockupGeometry, validateConfig } from './config-validator';
import { resolveBase } from './url-policy';

const CONFIG_URL = 'https://shop.example/customizer/data/tote-photo.json';
const policy = { pageOrigin: 'https://shop.example', allowedOrigins: [] as string[] };

function validate(
  raw: unknown,
  overrides: { configUrl?: string; allowedOrigins?: string[] } = {},
): ValidationResult {
  return validateConfig(raw, {
    resolvedBase: resolveBase({
      configUrl: overrides.configUrl ?? CONFIG_URL,
      baseUrl: null,
      documentBase: 'https://shop.example/',
    }),
    policy: { ...policy, allowedOrigins: overrides.allowedOrigins ?? [] },
  });
}

/** Deep clone of the tote sample that a test can break in one place. */
const tote = () => structuredClone(toteJson) as Record<string, any>;

function issuesFor(raw: unknown): string[] {
  const result = validate(raw);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((i) => `${i.path}|${i.code}`);
}

describe('validateConfig: shipped samples', () => {
  const samples: [string, unknown][] = [
    ['tote-photo', toteJson],
    ['tshirt-text', tshirtJson],
    ['poster-artwork', posterJson],
  ];

  it.each(samples)('accepts %s and resolves every asset to an absolute URL', (_name, json) => {
    const result = validate(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const urls = [
      result.config.assetBaseUrl,
      result.config.mockup.src,
      ...result.config.fonts.map((f) => f.src),
      ...result.config.layers.flatMap((l) => (l.type === 'fixed-image' ? [l.src] : [])),
      ...result.config.fields.flatMap((f) =>
        f.type === 'artwork' ? f.choices.map((c) => c.src) : [],
      ),
    ];
    for (const url of urls) expect(url).toMatch(/^https:\/\/shop\.example\/customizer\/assets\//);
  });

  it.each(samples)('%s satisfies the published JSON Schema', (_name, json) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const check = ajv.compile(schema);
    expect(check(json), JSON.stringify(check.errors)).toBe(true);
  });

  it('the JSON Schema and the runtime validator agree on structural mistakes', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const check = ajv.compile(schema);
    const mutations: ((c: Record<string, any>) => void)[] = [
      (c) => (c['schemaVersion'] = 2),
      (c) => (c['canvas'].width = 5000),
      (c) => (c['fields'][0].maxLength = 101),
      (c) => (c['fields'][0].colors = ['red']),
      (c) => (c['layers'][0].type = 'video'),
      (c) => (c['displayPrice'].exponent = 7),
      (c) => (c['fields'][0].surprise = true),
      (c) => (c['displayPrice'].currency = 'inr'),
      (c) => (c['mockup'].placement.width = 0),
      (c) => (c['print'].minDpi = 50),
    ];
    for (const mutate of mutations) {
      const broken = tote();
      mutate(broken);
      expect(check(broken)).toBe(false);
      expect(validate(broken).ok).toBe(false);
    }
  });

  it('keeps host-supplied objects untouched (validation works on a copy)', () => {
    const original = tote();
    const snapshot = JSON.stringify(original);
    validate(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('validateConfig: rejections (F01, section 8)', () => {
  it('rejects unsupported schema versions before anything else', () => {
    const config = tote();
    config['schemaVersion'] = 99;
    expect(issuesFor(config)).toEqual(['schemaVersion|unsupported-version']);
  });

  it('rejects duplicate ids', () => {
    const config = tote();
    config['fields'][1].id = 'name';
    config['layers'][1].id = 'photo-layer';
    expect(issuesFor(config)).toEqual(
      expect.arrayContaining(['fields[1].id|duplicate-id', 'layers[1].id|duplicate-id']),
    );
  });

  it('rejects layers that reference undeclared fields', () => {
    const config = tote();
    config['layers'][0].fieldId = 'ghost';
    expect(issuesFor(config)).toContain('layers[0].fieldId|unknown-reference');
  });

  it('rejects a layer whose type does not match its field', () => {
    const config = tote();
    config['layers'][0].type = 'artwork';
    expect(issuesFor(config)).toContain('layers[0].fieldId|type-mismatch');
  });

  it('rejects unknown field and layer types', () => {
    const config = tote();
    config['fields'][2].type = 'video';
    config['layers'][2].type = 'hologram';
    expect(issuesFor(config)).toEqual(
      expect.arrayContaining(['fields[2].type|unknown-type', 'layers[2].type|unknown-type']),
    );
  });

  it.each([-1, 2.5, 5, 99])('rejects currency exponent %s', (exponent) => {
    const config = tote();
    config['displayPrice'].exponent = exponent;
    expect(issuesFor(config).some((i) => i.startsWith('displayPrice.exponent'))).toBe(true);
  });

  it.each(['red', '#12', '#12345', 'rgb(0,0,0)', 'url(x)'])('rejects colour %s', (color) => {
    const config = tote();
    config['fields'][0].colors = [color];
    expect(issuesFor(config)).toContain('fields[0].colors[0]|color');
  });

  it.each([
    ['javascript:alert(1)', 'unsupported-protocol'],
    ['data:image/png;base64,AAAA', 'unsupported-protocol'],
    ['blob:https://shop.example/abc', 'unsupported-protocol'],
    ['file:///etc/passwd', 'unsupported-protocol'],
    ['ftp://example.com/a.png', 'unsupported-protocol'],
    ['../secrets/a.png', 'path-traversal'],
    ['clipart/../../a.png', 'path-traversal'],
    ['clipart/%2e%2e/a.png', 'path-traversal'],
    ['https://user:pw@cdn.example/a.png', 'credentials-in-url'],
    ['clip\\art.png', 'invalid-url'],
  ])('rejects asset path %s', (src, code) => {
    const config = tote();
    config['mockup'].src = src;
    expect(issuesFor(config)).toContain(`mockup.src|${code}`);
  });

  it('enforces the host origin allow-list but always allows the page origin', () => {
    const config = tote();
    config['assetBaseUrl'] = 'https://cdn.example/assets/';
    expect(validate(config, { allowedOrigins: ['https://other.example'] }).ok).toBe(false);
    expect(validate(config, { allowedOrigins: ['https://cdn.example'] }).ok).toBe(true);
    const local = tote();
    expect(validate(local, { allowedOrigins: ['https://cdn.example'] }).ok).toBe(true);
  });

  it('rejects layers that leave the canvas and zero-sized layers', () => {
    const config = tote();
    config['layers'][0].x = 600;
    config['layers'][1].width = 0;
    const issues = issuesFor(config);
    expect(issues).toContain('layers[0]|bounds');
    expect(issues).toContain('layers[1]|range');
  });

  it('rejects a print size whose aspect ratio differs from the canvas', () => {
    const config = tote();
    config['print'].heightMm = 150;
    expect(issuesFor(config)).toContain('print|aspect-mismatch');
  });

  it('only lets a configuration raise the DPI floors', () => {
    const config = tote();
    config['print'].warnDpi = 120;
    expect(issuesFor(config)).toContain('print.warnDpi|range');
    const raised = tote();
    raised['print'].warnDpi = 200;
    raised['print'].minDpi = 150;
    expect(validate(raised).ok).toBe(true);
  });

  it('rejects unsafe font family names (they end up in canvas font strings)', () => {
    const config = tote();
    config['fonts'][0].family = 'Evil"; src: url(x)';
    expect(issuesFor(config)).toContain('fonts[0].family|font-family');
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__'])(
    'rejects the id "%s", which would collide with Object.prototype members',
    (reserved) => {
      const asField = tote();
      asField['fields'][0].id = reserved;
      asField['layers'][1].fieldId = reserved;
      expect(issuesFor(asField)).toContain(
        reserved === '__proto__' ? 'fields[0].id|id' : 'fields[0].id|reserved-id',
      );

      const asOthers = tote();
      asOthers['layers'][0].id = reserved;
      asOthers['fonts'][0].id = reserved;
      asOthers['fields'][2].choices[0].id = reserved;
      asOthers['templateId'] = reserved;
      const issues = issuesFor(asOthers);
      for (const path of ['layers[0].id', 'fonts[0].id', 'fields[2].choices[0].id', 'templateId']) {
        expect(
          issues.some((i) => i.startsWith(`${path}|`)),
          path,
        ).toBe(true);
      }
    },
  );

  it('rejects typos instead of silently ignoring them', () => {
    const config = tote();
    config['fields'][0].maxLenght = 5;
    expect(issuesFor(config)).toContain('fields[0].maxLenght|unknown-property');
  });

  it('enforces the v1 limits', () => {
    const config = tote();
    config['fields'][0].maxLength = 101;
    config['canvas'] = { width: 4097, height: 100 };
    expect(issuesFor(config)).toEqual(
      expect.arrayContaining(['fields[0].maxLength|range', 'canvas.width|range']),
    );

    const manyFonts = tote();
    manyFonts['fonts'] = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`,
      family: `F${i}`,
      src: 'a.woff2',
    }));
    expect(issuesFor(manyFonts)).toContain('fonts|length');

    const manyChoices = tote();
    manyChoices['fields'][2].choices = Array.from({ length: 21 }, (_, i) => ({
      id: `c${i}`,
      label: `C${i}`,
      src: 'a.png',
    }));
    expect(issuesFor(manyChoices)).toContain('fields[2].choices|length');

    const manyFields = tote();
    manyFields['fields'] = Array.from({ length: 11 }, (_, i) => ({
      id: `t${i}`,
      type: 'image',
      label: 'x',
      required: false,
    }));
    expect(issuesFor(manyFields)).toContain('fields|length');

    const manyLayers = tote();
    manyLayers['layers'] = Array.from({ length: 21 }, (_, i) => ({
      id: `l${i}`,
      type: 'fixed-image',
      src: 'a.png',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    }));
    expect(issuesFor(manyLayers)).toContain('layers|length');
  });

  it('requires every field to have exactly one editable layer', () => {
    const missing = tote();
    missing['layers'] = missing['layers'].filter((l: any) => l.fieldId !== 'motif');
    expect(issuesFor(missing)).toContain('layers|field-without-layer');

    const twice = tote();
    twice['layers'].push({ ...twice['layers'][0], id: 'photo-again' });
    expect(issuesFor(twice)).toContain('layers[3].fieldId|multiple-layers');
  });

  it('keeps fixed layers non-editable', () => {
    const config = tote();
    config['layers'].push({
      id: 'logo',
      type: 'fixed-image',
      fieldId: 'name',
      src: 'clipart/star.png',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(issuesFor(config)).toContain('layers[3].fieldId|unknown-property');
  });

  it('rejects invalid text defaults', () => {
    const config = tote();
    config['fields'][0].defaultValue = { text: 'x'.repeat(30), fontId: 'nope', color: '#000000' };
    expect(issuesFor(config)).toEqual(
      expect.arrayContaining([
        'fields[0].defaultValue.text|too-long',
        'fields[0].defaultValue.fontId|unknown-reference',
        'fields[0].defaultValue.color|unknown-reference',
      ]),
    );
  });

  it('rejects non-object input without throwing', () => {
    for (const bad of [null, 42, 'config', [], undefined]) {
      expect(validate(bad).ok).toBe(false);
    }
  });
});

describe('checkMockupGeometry', () => {
  const config = (): CustomizerConfig => {
    const result = validate(tote());
    if (!result.ok) throw new Error('fixture invalid');
    return result.config;
  };

  it('accepts a placement that preserves the canvas aspect ratio', () => {
    expect(checkMockupGeometry(config(), 1600, 1600)).toBeNull();
  });

  it('rejects, rather than stretches, a mismatched mockup', () => {
    const issue = checkMockupGeometry(config(), 1600, 1000);
    expect(issue?.code).toBe('mockup-aspect-mismatch');
  });
});
