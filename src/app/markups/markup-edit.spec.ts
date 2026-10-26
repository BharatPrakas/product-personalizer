import tshirtJson from '../../../public/data/products/tshirt.json';
import { ProductConfig } from '../customizer/models/product.models';
import { validateProductConfig } from '../customizer/util/product-validator';
import { resolveBase } from '../customizer/util/url-policy';
import {
  areaToMarkup,
  artworkToMarkup,
  insertAreaMarkup,
  insertArtworkMarkup,
} from './markup-edit';
import { MarkupInvalidError, parsePayload, validateName } from './markup.models';

function load(json: unknown): ProductConfig {
  const result = validateProductConfig(JSON.parse(JSON.stringify(json)), {
    resolvedBase: resolveBase({
      configUrl: 'https://shop.example/c/x.json',
      baseUrl: null,
      documentBase: 'https://shop.example/',
    }),
    policy: { pageOrigin: 'https://shop.example', allowedOrigins: [] },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

const valid = (config: ProductConfig) =>
  validateProductConfig(JSON.parse(JSON.stringify(config)), {
    resolvedBase: resolveBase({
      configUrl: 'https://shop.example/c/x.json',
      baseUrl: null,
      documentBase: 'https://shop.example/',
    }),
    policy: { pageOrigin: 'https://shop.example', allowedOrigins: [] },
  });

describe('markup edit', () => {
  const source = load(tshirtJson);
  const withText = source.artworks.find((a) =>
    a.layers.some((l) => l.type === 'text' && l.fieldId),
  )!;

  it('captures an area without artwork or placement', () => {
    const area = source.printableAreas[0];
    const payload = areaToMarkup(source, area.id)!;
    expect(payload).toMatchObject({
      v: 1,
      kind: 'area',
      area: { name: area.name, canvas: area.canvas, shape: area.shape },
    });
    expect(JSON.stringify(payload)).not.toContain('artworkId');
    expect(areaToMarkup(source, 'nope')).toBeNull();
  });

  it('captures an artwork with exactly the fields its layers use, minus scope and rules', () => {
    const payload = artworkToMarkup(source, withText.id)!;
    const used = new Set(
      withText.layers.flatMap((l) => ('fieldId' in l && l.fieldId ? [l.fieldId] : [])),
    );
    expect(payload.fields.map((f) => f.id).sort()).toEqual([...used].sort());
    for (const f of payload.fields) {
      expect(f).not.toHaveProperty('printableAreaId');
      expect(f).not.toHaveProperty('artworkId');
      expect(f).not.toHaveProperty('showWhen');
    }
  });

  it('inserting an area creates a valid area with its own artwork and leaves the rest alone', () => {
    const payload = areaToMarkup(source, source.printableAreas[0].id)!;
    const result = insertAreaMarkup(source, payload, { name: 'Sleeve' });
    expect(result.config.printableAreas).toHaveLength(source.printableAreas.length + 1);
    const area = result.config.printableAreas.find((a) => a.id === result.areaId)!;
    expect(area.name).toBe('Sleeve');
    expect(area.canvas).toEqual(payload.area.canvas);
    expect(area.artworkId).toBe(result.artworkId);
    expect(result.config.artworks.find((a) => a.id === result.artworkId)!.layers).toEqual([]);
    expect(valid(result.config).ok).toBe(true);
    // The source template is untouched (copy-on-insert, not a link).
    expect(source.printableAreas).toHaveLength(load(tshirtJson).printableAreas.length);
  });

  it('inserting an artwork twice gives every layer, field and artwork a fresh id and a valid config', () => {
    const payload = artworkToMarkup(source, withText.id)!;
    const area = source.printableAreas.find((a) => a.id !== withText.printableAreaId)!;
    const first = insertArtworkMarkup(source, area.id, payload)!;
    const second = insertArtworkMarkup(first.config, area.id, payload)!;
    const layerIds = second.config.artworks.flatMap((a) => a.layers.map((l) => l.id));
    expect(new Set(layerIds).size).toBe(layerIds.length);
    const fieldIds = second.config.fields.map((f) => f.id);
    expect(new Set(fieldIds).size).toBe(fieldIds.length);
    expect(new Set(second.config.artworks.map((a) => a.id)).size).toBe(
      second.config.artworks.length,
    );
    const inserted = second.config.artworks.find((a) => a.id === second.artworkId)!;
    expect(inserted.printableAreaId).toBe(area.id);
    for (const l of inserted.layers)
      if ('fieldId' in l && l.fieldId) {
        const field = second.config.fields.find((f) => f.id === l.fieldId)!;
        expect(field.printableAreaId).toBe(area.id);
        expect(field.artworkId).toBe(second.artworkId);
      }
    expect(second.config.printableAreas.find((a) => a.id === area.id)!.artworkIds).toContain(
      second.artworkId,
    );
    expect(valid(second.config).ok).toBe(true);
  });

  it("falls back to an available font when the target template lacks the markup's fonts", () => {
    const payload = artworkToMarkup(source, withText.id)!;
    const poor: ProductConfig = { ...source, fonts: [source.fonts[0]] };
    const cleaned = {
      ...poor,
      fields: poor.fields.map((f) =>
        f.type === 'text' ? { ...f, fontIds: [poor.fonts[0].id] } : f,
      ),
      artworks: poor.artworks.map((a) => ({
        ...a,
        layers: a.layers.map((l) => (l.type === 'text' ? { ...l, fontId: poor.fonts[0].id } : l)),
      })),
    } as ProductConfig;
    const textField = payload.fields.find((f) => f.type === 'text');
    if (textField && textField.type === 'text') textField.fontIds = ['a-font-this-template-lacks'];
    const result = insertArtworkMarkup(cleaned, cleaned.printableAreas[0].id, payload)!;
    expect(result.warnings).toContain('fonts');
    for (const f of result.config.fields)
      if (f.type === 'text')
        for (const id of f.fontIds) expect(cleaned.fonts.some((x) => x.id === id)).toBe(true);
  });

  it('refuses to insert into an area that does not exist', () => {
    expect(insertArtworkMarkup(source, 'nope', artworkToMarkup(source, withText.id)!)).toBeNull();
  });
});

describe('markup payload checks', () => {
  it('rejects unsupported or incomplete payloads', () => {
    expect(() => parsePayload(null, 'area')).toThrow(MarkupInvalidError);
    expect(() => parsePayload({ v: 2, kind: 'area' }, 'area')).toThrow(MarkupInvalidError);
    expect(() =>
      parsePayload(
        { v: 1, kind: 'artwork', artwork: { name: 'x', layers: 'no' }, fields: [] },
        'artwork',
      ),
    ).toThrow(MarkupInvalidError);
    expect(() =>
      parsePayload(
        {
          v: 1,
          kind: 'area',
          area: { name: 'x', canvas: { width: 1, height: 1 }, shape: { type: 'rect' } },
        },
        'artwork',
      ),
    ).toThrow(MarkupInvalidError);
    expect(
      parsePayload(
        {
          v: 1,
          kind: 'area',
          area: { name: 'x', canvas: { width: 1, height: 1 }, shape: { type: 'rect' } },
        },
        'area',
      ).kind,
    ).toBe('area');
  });

  it('validates names', () => {
    expect(validateName('  Heart  ')).toBe('Heart');
    expect(() => validateName('   ')).toThrow(MarkupInvalidError);
    expect(() => validateName('x'.repeat(121))).toThrow(MarkupInvalidError);
  });
});
