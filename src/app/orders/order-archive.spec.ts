import { CONFIG, CUSTOMIZATION, LINE, ORDER } from './order-fixtures';
import { lineArchive, lineArchiveName, orderArchive, orderArchiveName, singleFileName, type LineSource } from './order-archive';
import { readSavedDesign } from './order-view';

const source: LineSource = { line: LINE, customization: CUSTOMIZATION, design: readSavedDesign(CUSTOMIZATION.data), config: CONFIG };

describe('download archive layout', () => {
  it('names archives safely', () => {
    expect(lineArchiveName('ORD-1', 'L-1')).toBe('order-ORD-1-line-L-1.zip');
    expect(lineArchiveName('ORD/../1', 'L/1')).toBe('order-ORD-..-1-line-L-1.zip');
    expect(orderArchiveName('../../x')).toBe('order--..-x.zip');
  });

  it('lays out one line: production/, previews/, uploads/, customization.json', () => {
    const plan = lineArchive(ORDER, source);
    expect(plan.filename).toBe('order-ORD-..-1-line-L-1.zip');
    expect(plan.entries.map((e) => e.path)).toEqual([
      'production/Wrap.png',
      'previews/Front view.png',
      'previews/Front view (2).png', // two mockups with the same name never collide
      'uploads/Your photo.jpg',
      'production/a9.png',
      'customization.json',
    ]);
    // `../Handle` is referenced but gone: reported (with a sanitised path), never fetched.
    expect(plan.missing).toEqual([{ path: 'production/-Handle.png', label: '../Handle' }]);
    expect(plan.entries[0].source).toEqual({ kind: 'asset', customizationId: 'cz-1', assetId: 'art-1' });
    for (const entry of [...plan.entries, ...plan.missing]) {
      expect(entry.path.split('/').every((segment) => segment && segment !== '..' && segment !== '.')).toBe(true);
    }
  });

  it('writes the design and order-line metadata, but no customer data, into customization.json', () => {
    const json = lineArchive(ORDER, source).entries.find((e) => e.path === 'customization.json')!;
    expect(json.source.kind).toBe('json');
    const value = (json.source as { value: any }).value;
    expect(value.order).toEqual({ orderId: 'ORD/../1', orderNumber: '#1001', placedAt: ORDER.placedAt, currency: 'EUR' });
    expect(value.line).toMatchObject({ lineId: 'L/1', sku: 'MUG', quantity: 2 });
    expect(value.customization).toEqual({ id: 'cz-1', status: 'ordered', configId: 'cfg-mug', configVersion: 3 });
    expect(value.data).toBe(CUSTOMIZATION.data);
    const text = JSON.stringify(value);
    for (const pii of ['Zelda', 'z@example.test', '1 Road', '69001']) expect(text).not.toContain(pii);
  });

  it('puts every line of an order in its own folder, unique even when line ids sanitise alike', () => {
    const other = { ...source, line: { ...LINE, lineId: 'L:1' } };
    const plan = orderArchive(ORDER, [source, other]);
    expect(plan.filename).toBe('order-ORD-..-1.zip');
    const folders = [...new Set(plan.entries.map((e) => e.path.split('/')[0]))];
    expect(folders).toEqual(['line-L-1', 'line-L-1 (2)']);
    expect(plan.entries.filter((e) => e.path.endsWith('customization.json'))).toHaveLength(2);
    expect(plan.missing.map((m) => m.path)).toEqual(['line-L-1/production/-Handle.png', 'line-L-1 (2)/production/-Handle.png']);
  });

  it('names a single downloaded file after its order, line and label', () => {
    const file = { group: 'production' as const, kind: 'artwork' as const, label: 'Wrap', asset: LINE.assets[0], width: 1, height: 1 };
    expect(singleFileName(ORDER, LINE, file)).toBe('order-ORD-..-1-line-L-1-production-Wrap.png');
  });
});
