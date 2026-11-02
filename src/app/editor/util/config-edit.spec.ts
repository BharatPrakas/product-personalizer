import type { ProductConfig } from '../../customizer/models/product.models';
import { emptyConfiguration } from '../../workspace/empty-configuration';
import { addArea, removeArea, type NewAreaInput } from './config-edit';

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
