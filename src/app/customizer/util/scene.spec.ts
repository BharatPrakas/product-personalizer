import toteJson from '../../../../public/data/tote-photo.json';
import tshirtJson from '../../../../public/data/tshirt-text.json';
import { CustomizerConfig } from '../models/config.models';
import { validateConfig } from './config-validator';
import { DraftValues, defaultValues } from './draft-utils';
import { EvaluationEnv, LocalAsset, evaluateDraft } from './scene';
import { InkBox } from './text-fit';
import { resolveBase } from './url-policy';

function load(json: unknown): CustomizerConfig {
  const result = validateConfig(JSON.parse(JSON.stringify(json)), {
    resolvedBase: resolveBase({
      configUrl: 'https://shop.example/c/data/x.json',
      baseUrl: null,
      documentBase: 'https://shop.example/',
    }),
    policy: { pageOrigin: 'https://shop.example', allowedOrigins: [] },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

const bitmap = (width: number, height: number) =>
  ({ width, height, close: () => undefined }) as unknown as ImageBitmap;
const asset = (id: string, width: number, height: number): LocalAsset => ({
  assetId: id,
  blob: new Blob(),
  mimeType: 'image/jpeg',
  width,
  height,
  bitmap: bitmap(width, height),
});

/** 0.6em per character, centred. */
const measure = (font: string, _align: string, text: string): InkBox => {
  const size = Number(/^(\d+(?:\.\d+)?)px/.exec(font)?.[1]);
  const width = text.length * 0.6 * size;
  return { left: width / 2, right: width / 2, ascent: 0.75 * size, descent: 0.2 * size };
};

function env(config: CustomizerConfig, extra: Partial<EvaluationEnv> = {}): EvaluationEnv {
  const staticImages = new Map<string, ImageBitmap>();
  for (const field of config.fields)
    if (field.type === 'artwork')
      field.choices.forEach((c) => staticImages.set(c.src, bitmap(256, 256)));
  for (const layer of config.layers)
    if (layer.type === 'fixed-image') staticImages.set(layer.src, bitmap(256, 256));
  return {
    config,
    fontFamilies: new Map(config.fonts.map((f) => [f.id, `zb-${f.id}`])),
    staticImages,
    localAssets: new Map(),
    measure,
    missingGlyphs: () => [],
    ...extra,
  };
}

const tote = load(toteJson);
const tshirt = load(tshirtJson);

const withName = (text: string, base: DraftValues = defaultValues(tote)): DraftValues => ({
  ...base,
  name: { text, fontId: 'sans', color: '#296FD7' },
});

const codes = (config: CustomizerConfig, values: DraftValues, extra: Partial<EvaluationEnv> = {}) =>
  evaluateDraft(env(config, extra), values).errors.map((e) => `${e.fieldId}:${e.code}`);

describe('evaluateDraft: text (F02, F03)', () => {
  it('requires required text, with the field label in the message', () => {
    const result = evaluateDraft(env(tote), defaultValues(tote));
    expect(result.errors).toContainEqual({
      fieldId: 'name',
      code: 'required',
      message: 'Your name is required.',
    });
    expect(result.scene.ops).toHaveLength(0);
  });

  it('treats whitespace-only text as empty', () => {
    expect(codes(tote, withName('   '))).toContain('name:required');
  });

  it('draws valid text centred in the layer box using the chosen font and colour', () => {
    const result = evaluateDraft(env(tote), withName('Alex'));
    expect(result.errors.filter((e) => e.fieldId === 'name')).toEqual([]);
    const op = result.scene.ops.find((o) => o.kind === 'text');
    expect(op).toMatchObject({
      kind: 'text',
      text: 'Alex',
      color: '#296FD7',
      align: 'center',
      font: '90px "zb-sans"',
    });
    if (op?.kind !== 'text') return;
    // layer box x 100..1100, y 940..1080 -> centre (600, 1010). Fake ink: 90px -> ascent 67.5, descent 18.
    expect(op.x).toBeCloseTo(600);
    expect(op.y).toBeCloseTo(1010 + (67.5 - 18) / 2);
  });

  it('shrinks long text and records the chosen size', () => {
    const result = evaluateDraft(env(tote), withName('A'.repeat(24)));
    // 24 * 0.6 = 14.4em; 1000 / 14.4 = 69.4 -> 69
    expect(result.textFit['name']).toEqual({ fontSize: 69, fits: true });
    expect(result.errors.filter((e) => e.fieldId === 'name')).toEqual([]);
  });

  it('blocks text that cannot fit at the minimum size, without truncating it', () => {
    const wide = (_f: string, _a: string, text: string): InkBox => ({
      left: text.length * 50,
      right: text.length * 50,
      ascent: 10,
      descent: 2,
    });
    const result = evaluateDraft(env(tote, { measure: wide }), withName('A'.repeat(24)));
    expect(result.errors.map((e) => e.code)).toContain('text-overflow');
    const op = result.scene.ops.find((o) => o.kind === 'text');
    expect(op?.kind === 'text' && op.text).toBe('A'.repeat(24)); // shown as typed, never truncated
  });

  it('flags text over the character limit', () => {
    expect(codes(tote, withName('x'.repeat(25)))).toContain('name:too-long');
  });

  it('flags newlines', () => {
    expect(codes(tote, withName('a\nb'))).toContain('name:newline');
  });

  it('flags glyphs the font cannot draw and names them', () => {
    const result = evaluateDraft(
      env(tote, { missingGlyphs: (_f, chars) => chars.filter((c) => c === '漢') }),
      withName('Hi 漢'),
    );
    const error = result.errors.find((e) => e.code === 'unsupported-glyph');
    expect(error?.message).toContain('漢');
  });

  it('rejects fonts or colours the field does not offer', () => {
    const values = {
      ...withName('Alex'),
      name: { text: 'Alex', fontId: 'comic', color: '#296FD7' },
    };
    expect(codes(tote, values)).toContain('name:invalid-option');
  });

  it.each([
    ['a zero-width space', '\u{200b}'],
    ['joiners and a BOM', '\u{200c}\u{200d}\u{feff}'],
    ['a lone combining mark', '\u{301}'],
    ['no-break spaces', '\u{a0}\u{a0}'],
  ])('does not let %s satisfy a required field: it draws nothing', (_label, text) => {
    const result = evaluateDraft(env(tote), withName(text));
    expect(result.errors).toContainEqual(
      expect.objectContaining({ fieldId: 'name', code: 'required' }),
    );
    expect(result.scene.ops).toHaveLength(0);
  });

  it('does not probe glyphs while a structural problem already blocks Save (no work per pasted character)', () => {
    const missingGlyphs = vi.fn(() => []);
    evaluateDraft(env(tote, { missingGlyphs }), withName('x'.repeat(25)));
    evaluateDraft(env(tote, { missingGlyphs }), withName('a\nb'));
    expect(missingGlyphs).not.toHaveBeenCalled();
    evaluateDraft(env(tote, { missingGlyphs }), withName('fine'));
    expect(missingGlyphs).toHaveBeenCalledOnce();
  });

  it('skips fitting and drawing for absurdly long input but still reports the error', () => {
    const measure = vi.fn(env(tote).measure);
    const result = evaluateDraft(env(tote, { measure }), withName('x'.repeat(24 * 8 + 1)));
    expect(result.errors.map((e) => `${e.fieldId}:${e.code}`)).toEqual([
      'name:too-long',
      'photo:required',
    ]);
    expect(measure).not.toHaveBeenCalled();
    expect(result.scene.ops).toHaveLength(0);

    // just over the limit is still previewed, so the shopper sees what they typed
    const near = evaluateDraft(env(tote), withName('x'.repeat(30)));
    expect(near.scene.ops.some((o) => o.kind === 'text')).toBe(true);
  });

  it('keeps optional empty text silent', () => {
    expect(
      codes(tshirt, {
        ...defaultValues(tshirt),
        number: { text: '', fontId: 'sans', color: '#111827' },
      }),
    ).toEqual([]);
  });
});

describe('evaluateDraft: photos (F04-F06)', () => {
  const values = (
    assetId: string | null,
    crop: [number, number, number, number] | null,
  ): DraftValues => ({
    ...withName('Alex'),
    photo: { assetId, crop },
  });

  it('requires the photo', () => {
    expect(codes(tote, withName('Alex'))).toEqual(['photo:required']);
  });

  it('draws the crop to fill the layer exactly (cover, never stretch)', () => {
    const a = asset('local-1', 1800, 1200);
    const result = evaluateDraft(
      env(tote, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', [1 / 6, 0, 2 / 3, 1]),
    );
    const op = result.scene.ops.find((o) => o.kind === 'image');
    expect(op).toMatchObject({
      sx: 300,
      sy: 0,
      sw: 1200,
      sh: 1200,
      dx: 200,
      dy: 100,
      dw: 800,
      dh: 800,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolution['photo'].dpi).toBeCloseTo(225, 3);
    expect(result.resolution['photo'].level).toBe('ok');
  });

  it('uses the centred default crop when none is stored', () => {
    const a = asset('local-1', 1800, 1200);
    const result = evaluateDraft(
      env(tote, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', null),
    );
    const op = result.scene.ops.find((o) => o.kind === 'image');
    expect(op).toMatchObject({ sw: 1200, sh: 1200, sy: 0 });
    expect(op?.kind === 'image' && op.sx).toBeCloseTo(300);
  });

  it('warns below 150 DPI but still allows saving', () => {
    // 800 px across 5.333 in = 150 dpi; 700 px = 131 dpi
    const a = asset('local-1', 700, 700);
    const result = evaluateDraft(
      env(tote, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', [0, 0, 1, 1]),
    );
    expect(result.resolution['photo'].level).toBe('warn');
    expect(result.warnings['photo'][0]).toContain('131 DPI');
    expect(result.errors).toEqual([]);
  });

  it('blocks below 100 DPI', () => {
    const a = asset('local-1', 400, 400); // 75 dpi
    const result = evaluateDraft(
      env(tote, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', [0, 0, 1, 1]),
    );
    expect(result.resolution['photo'].level).toBe('block');
    expect(result.errors.map((e) => e.code)).toEqual(['low-resolution']);
  });

  it('honours higher configured thresholds', () => {
    const strict = structuredClone(tote);
    strict.print = { ...strict.print!, warnDpi: 300, minDpi: 200 };
    const a = asset('local-1', 1000, 1000); // 187 dpi
    const result = evaluateDraft(
      env(strict, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', [0, 0, 1, 1]),
    );
    expect(result.resolution['photo'].level).toBe('block');
  });

  it('makes no DPI claims without physical print dimensions', () => {
    const noPrint = structuredClone(tote);
    delete noPrint.print;
    const a = asset('local-1', 100, 100);
    const result = evaluateDraft(
      env(noPrint, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', [0, 0, 1, 1]),
    );
    expect(result.resolution).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it('does not treat a missing restored asset as valid (F11)', () => {
    expect(codes(tote, values('durable-42', [0, 0, 1, 1]))).toEqual(['photo:missing-asset']);
  });

  it('rejects a crop with the wrong aspect ratio and falls back to the default crop', () => {
    const a = asset('local-1', 1800, 1200);
    const result = evaluateDraft(
      env(tote, { localAssets: new Map([[a.assetId, a]]) }),
      values('local-1', [0, 0, 1, 0.5]),
    );
    expect(result.errors.map((e) => e.code)).toEqual(['invalid-crop']);
    expect(result.scene.ops.find((o) => o.kind === 'image')).toMatchObject({ sw: 1200, sh: 1200 });
  });
});

describe('evaluateDraft: artwork, fixed images and ordering (F07, F08)', () => {
  it('draws a chosen artwork "contain" inside its layer and nothing when unselected', () => {
    const none = evaluateDraft(env(tote), withName('Alex'));
    expect(none.scene.ops.filter((o) => o.kind === 'image')).toHaveLength(0);

    const chosen = evaluateDraft(env(tote), { ...withName('Alex'), motif: { choiceId: 'star' } });
    const op = chosen.scene.ops.find((o) => o.kind === 'image' && o.layerId === 'motif-layer');
    expect(op).toMatchObject({ dx: 1050, dy: 50, dw: 100, dh: 100 });
  });

  it('letterboxes artwork whose aspect ratio differs from the layer', () => {
    const staticImages = new Map(env(tote).staticImages);
    staticImages.set('https://shop.example/c/assets/clipart/star.png', bitmap(400, 200));
    const chosen = evaluateDraft(env(tote, { staticImages }), {
      ...withName('Alex'),
      motif: { choiceId: 'star' },
    });
    const op = chosen.scene.ops.find((o) => o.kind === 'image' && o.layerId === 'motif-layer');
    expect(op).toMatchObject({ dw: 100, dh: 50, dx: 1050, dy: 75 });
  });

  it('rejects an unknown artwork choice', () => {
    expect(codes(tote, { ...withName('Alex'), motif: { choiceId: 'dragon' } }, {})).toContain(
      'motif:invalid-option',
    );
  });

  it('draws fixed layers without any field', () => {
    const result = evaluateDraft(env(tshirt), defaultValues(tshirt));
    expect(result.scene.ops.find((o) => o.kind === 'image' && o.layerId === 'logo')).toMatchObject({
      dx: 520,
      dy: 40,
      dw: 160,
      dh: 160,
    });
  });

  it('keeps layers in configured back-to-front order', () => {
    const result = evaluateDraft(env(tshirt), defaultValues(tshirt));
    expect(result.scene.ops.map((o) => o.layerId)).toEqual(['logo', 'team-layer', 'number-layer']);
  });

  it('reports errors in field order and the scene has the configured pixel size', () => {
    const result = evaluateDraft(env(tote), defaultValues(tote));
    expect(result.errors.map((e) => e.fieldId)).toEqual(['name', 'photo']);
    expect(result.scene).toMatchObject({ width: 1200, height: 1200, background: 'transparent' });
  });
});
