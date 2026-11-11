import { CONFIG, DATA, LINE } from './order-fixtures';
import type { OrderSummary } from './order.models';
import { customerInputs, dayBounds, lineFiles, mergePage, orderStatus, priceOf, productNames, readSavedDesign } from './order-view';

describe('order view mapping', () => {
  it('reads the saved design defensively', () => {
    const design = readSavedDesign(DATA);
    expect(design.templateId).toBe('cfg-mug');
    expect(design.templateVersion).toBe(3);
    expect(design.uploads).toEqual([{ localId: 'local-1', ref: 'up-1' }]);
    expect(design.artworks.map((a) => a.ref)).toEqual(['art-1', 'art-gone']);
    expect(design.displayPrice?.totalMinor).toBe(2000);

    for (const junk of [null, 'x', 42, [], { customization: 'nope', files: { uploads: 'x' } }]) {
      const empty = readSavedDesign(junk);
      expect(empty.values).toEqual({});
      expect(empty.uploads).toEqual([]);
      expect(empty.displayPrice).toBeNull();
    }
  });

  it('labels every customer input from the pinned template, in its field order', () => {
    const inputs = customerInputs(readSavedDesign(DATA), CONFIG);
    expect(inputs.map((i) => [i.kind, i.label])).toEqual([
      ['text', 'Your name'],
      ['image', 'Your photo'],
      ['choice', 'Icon'],
      ['text', 'legacy'], // not in the template: raw id
      ['design', 'Wrap'],
      ['design', '../Handle'],
    ]);
    expect(inputs[0]).toMatchObject({ text: 'Ada', font: 'Inter Bold', color: '#112233', styles: ['bold'] });
    expect(inputs[1]).toMatchObject({ assetId: 'up-1', crop: [0.1, 0.2, 0.5, 0.6], fit: 'cover', rotation: 90 });
    expect(inputs[2]).toMatchObject({ value: 'Star' });
    expect(inputs[3]).toMatchObject({ font: 'gone' });
    expect(inputs[4]).toMatchObject({ value: 'Photo wrap' });
  });

  it('falls back to raw ids when the template version cannot be read', () => {
    const inputs = customerInputs(readSavedDesign(DATA), null);
    expect(inputs.map((i) => i.label)).toEqual(['icon', 'name', 'photo', 'legacy', 'a1', 'a2']);
    expect(inputs.find((i) => i.kind === 'choice')).toMatchObject({ value: 'c-star' });
  });

  it('lists the files of a line: labelled, grouped, missing ones flagged, unreferenced ones kept', () => {
    const files = lineFiles(LINE, readSavedDesign(DATA), CONFIG);
    expect(files.map((f) => [f.group, f.label, f.asset?.assetId ?? null])).toEqual([
      ['production', 'Wrap', 'art-1'],
      ['production', '../Handle', null], // referenced but gone
      ['previews', 'Front view', 'pre-1'],
      ['previews', 'Front view', 'pre-2'],
      ['uploads', 'Your photo', 'up-1'],
      ['production', 'a9', 'orphan'], // stored but not referenced by the design
    ]);
    expect(files[1]).toMatchObject({ width: 200, height: 200 });
    // Without any saved design every stored file is still listed.
    expect(lineFiles(LINE, null, null).map((f) => f.label)).toEqual(['a1', 'm1', 'm2', 'local-1', 'a9']);
  });

  it('computes prices in major units', () => {
    expect(priceOf(readSavedDesign(DATA).displayPrice!)).toEqual({ base: 15, fee: 5, total: 20 });
  });

  it('summarises orders for the list', () => {
    const order = (id: string, statuses: Array<'ordered' | 'expired'> = ['ordered']): OrderSummary => ({
      orderId: id, orderNumber: null, placedAt: null, customerName: null, linkedAt: '', lineCount: statuses.length,
      lines: statuses.map((status, i) => ({ lineId: `${i}`, productId: 'p', title: i % 2 ? 'Mug' : null, quantity: 1, status, customizationId: 'c', previewAssetId: null })),
    });
    expect(orderStatus(order('a', ['ordered', 'expired']))).toBe('expired');
    expect(orderStatus(order('a'))).toBe('ordered');
    expect(productNames(order('a', ['ordered', 'ordered', 'ordered']).lines)).toEqual(['p', 'Mug']);
    expect(mergePage([order('a'), order('b')], [order('b'), order('c')], true).map((o) => o.orderId)).toEqual(['a', 'b', 'c']);
    expect(mergePage([order('a')], [order('c')], false).map((o) => o.orderId)).toEqual(['c']);
  });

  it('turns date inputs into whole local days', () => {
    const { from, to } = dayBounds('2026-11-01', '2026-11-02');
    expect(new Date(from!).getTime()).toBe(new Date(2026, 10, 1).getTime());
    expect(new Date(to!).getTime()).toBe(new Date(2026, 10, 3).getTime() - 1);
    expect(dayBounds('', 'nonsense')).toEqual({});
  });
});
