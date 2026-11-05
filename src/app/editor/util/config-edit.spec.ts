import type { TextFieldSpec } from '../../customizer/models/config.models';
import type { ProductConfig, TextLayer } from '../../customizer/models/product.models';
import { emptyConfiguration } from '../../workspace/empty-configuration';
import { addArea, addFont, addLayer, removeArea, removeFont, type NewAreaInput } from './config-edit';

const RECT: NewAreaInput = {
  name: 'Front',
  shape: { type: 'rect' },
  canvasWidth: 1000,
  canvasHeight: 1000,
};

describe('removeArea', () => {
  it('removes the only printable area without throwing and leaves the variants without areas', () => {
    const { config, areaId } = addArea(emptyConfiguration('cfg-1', 'Tee'), RECT);
    expect(config.variants[0].printableAreaIds).toEqual([areaId]);

    const next = removeArea(config, areaId);

    expect(next.printableAreas).toEqual([]);
    expect(next.artworks).toEqual([]);
    expect(next.variants.map((v) => v.printableAreaIds)).toEqual([[]]);
  });

  it('removes the last area of a configuration that had several', () => {
    const front = addArea(emptyConfiguration('cfg-1', 'Tee'), RECT);
    const back = addArea(front.config, { ...RECT, name: 'Back' });
    const afterFirst = removeArea(back.config, front.areaId);
    expect(afterFirst.printableAreas.map((a) => a.id)).toEqual([back.areaId]);

    const afterSecond = removeArea(afterFirst, back.areaId);

    expect(afterSecond.printableAreas).toEqual([]);
    expect(afterSecond.variants.map((v) => v.printableAreaIds)).toEqual([[]]);
  });

  it('keeps the other areas of a variant when one is removed', () => {
    const front = addArea(emptyConfiguration('cfg-1', 'Tee'), RECT);
    const back = addArea(front.config, { ...RECT, name: 'Back' });

    const next = removeArea(back.config, front.areaId);

    expect(next.printableAreas.map((a) => a.id)).toEqual([back.areaId]);
    expect(next.artworks.map((a) => a.printableAreaId)).toEqual([back.areaId]);
    expect(next.variants[0].printableAreaIds).toEqual([back.areaId]);
  });

  it('moves a variant that only had the removed area onto the first remaining area', () => {
    const front = addArea(emptyConfiguration('cfg-1', 'Tee'), RECT);
    const back = addArea(front.config, { ...RECT, name: 'Back' });
    const config: ProductConfig = {
      ...back.config,
      variants: [
        ...back.config.variants,
        { id: 'small', label: 'Small', mockupIds: [], printableAreaIds: [front.areaId] },
      ],
    };

    const next = removeArea(config, front.areaId);

    expect(next.variants.map((v) => v.printableAreaIds)).toEqual([[back.areaId], [back.areaId]]);
  });
});

/** An empty config with one text field and one fixed text layer, both defaulted to the 'sans' font. */
function withTextLayers(): { config: ProductConfig; fieldId: string; layerId: string } {
  const { config: withArea, areaId } = addArea(emptyConfiguration('cfg-1', 'Tee'), RECT);
  const artworkId = withArea.artworks.find((a) => a.printableAreaId === areaId)!.id;
  const editable = addLayer(withArea, artworkId, 'text-editable')!;
  const fixed = addLayer(editable.config, artworkId, 'text-fixed')!;
  return { config: fixed.config, fieldId: editable.fieldId!, layerId: fixed.layerId };
}

describe('addFont', () => {
  it('adds the font and makes it an allowed choice on every text field', () => {
    const { config, fieldId } = withTextLayers();
    const before = config.fields.find((f) => f.id === fieldId) as TextFieldSpec;

    const { config: next, id } = addFont(config, { family: 'Brand', label: 'Brand Headline', src: 'https://cdn/x.woff2' });

    expect(next.fonts.map((f) => f.id)).toEqual([...config.fonts.map((f) => f.id), id]);
    const field = next.fields.find((f) => f.id === fieldId) as TextFieldSpec;
    expect(field.fontIds).toEqual([...before.fontIds, id]);
  });

  it('derives a unique id from the label, and is idempotent for a repeated explicit id', () => {
    const base = emptyConfiguration('cfg-1', 'Tee');
    const first = addFont(base, { family: 'Brand', label: 'Brand Headline', src: 'x' });
    expect(first.id).not.toBe('sans'); // does not collide with a bundled font id
    expect(base.fonts.some((f) => f.id === first.id)).toBe(false); // input untouched

    const again = addFont(first.config, { id: first.id, family: 'Brand', label: 'Brand Headline', src: 'x' });
    expect(again.config.fonts.filter((f) => f.id === first.id)).toHaveLength(1);
    expect(again.config).toBe(first.config); // no-op: same reference back
  });
});

describe('removeFont', () => {
  it('drops a font nothing references', () => {
    const { config } = withTextLayers();
    const { config: withCustom, id } = addFont(config, { family: 'Brand', label: 'Brand', src: 'x' });

    const next = removeFont(withCustom, id);

    expect(next.fonts.map((f) => f.id)).toEqual(config.fonts.map((f) => f.id));
  });

  it('falls back every reference (field default, field choices, fixed layer) to the new first font', () => {
    const { config, fieldId, layerId } = withTextLayers();
    const removedId = config.fonts[0].id; // 'sans' — what every reference above points at
    const fallback = config.fonts[1].id; // 'sans-bold'

    const next = removeFont(config, removedId);

    expect(next.fonts.some((f) => f.id === removedId)).toBe(false);
    const field = next.fields.find((f) => f.id === fieldId) as TextFieldSpec;
    expect(field.fontIds).not.toContain(removedId);
    expect(field.fontIds).toContain(fallback);
    expect(field.defaultValue?.fontId).toBe(fallback);
    const layer = next.artworks.flatMap((a) => a.layers).find((l) => l.id === layerId) as TextLayer;
    expect(layer.fontId).toBe(fallback);
  });

  it('never leaves a field with zero font choices', () => {
    const { config, fieldId } = withTextLayers();
    const onlyFont = config.fonts[2].id; // 'serif' — not otherwise referenced
    const restricted: ProductConfig = {
      ...config,
      fields: config.fields.map((f) => (f.id === fieldId ? { ...(f as TextFieldSpec), fontIds: [onlyFont] } : f)),
    };

    const next = removeFont(restricted, onlyFont);

    const field = next.fields.find((f) => f.id === fieldId) as TextFieldSpec;
    expect(field.fontIds).toEqual([next.fonts[0].id]);
    expect(field.fontIds.length).toBeGreaterThan(0);
  });

  it('refuses to remove the last remaining font', () => {
    let config = emptyConfiguration('cfg-1', 'Tee');
    for (const font of [...config.fonts].slice(1)) config = removeFont(config, font.id);
    expect(config.fonts).toHaveLength(1);

    const next = removeFont(config, config.fonts[0].id);

    expect(next).toBe(config); // unchanged, same reference back
    expect(next.fonts).toHaveLength(1);
  });

  it('is a no-op for an unknown font id', () => {
    const { config } = withTextLayers();
    expect(removeFont(config, 'no-such-font')).toBe(config);
  });
});
