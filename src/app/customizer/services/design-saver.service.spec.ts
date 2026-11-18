import { TestBed } from '@angular/core/testing';
import type { PersonalizationSavedData } from '../models/extension-contract';
import { DesignPersister } from './design-persister.service';
import { DesignSaver, DesignToPersist, SaveContext } from './design-saver.service';
import type { SavePayload } from './export.service';

const design = (over: Partial<DesignToPersist> = {}): DesignToPersist => ({
  payload: {} as SavePayload,
  valuesKey: 'values-1',
  templateId: 'tpl',
  templateVersion: 2,
  source: 'save',
  ...over,
});

describe('DesignSaver', () => {
  let context: SaveContext;
  let saved: PersonalizationSavedData[];
  let calls: Array<{ resolve: (v: { customizationId: string; expiresAt: string }) => void; reject: (e: unknown) => void; signal: AbortSignal }>;
  let saver: DesignSaver;

  beforeEach(() => {
    context = { apiBaseUrl: 'https://api.example', storeId: 's', productId: 'p1', variantId: 'white', collectionIds: [] };
    saved = [];
    calls = [];
    const fake = {
      persist: (_context: unknown, _payload: unknown, signal: AbortSignal) =>
        new Promise((resolve, reject) => calls.push({ resolve: resolve as never, reject, signal })),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [DesignSaver, { provide: DesignPersister, useValue: fake }] });
    saver = TestBed.inject(DesignSaver);
    saver.bind({ context: () => context, saved: (data) => saved.push(data) });
  });

  const finish = (i: number, id = `cz-${i + 1}`) => calls[i].resolve({ customizationId: id, expiresAt: '2999-01-01T00:00:00Z' });

  it('shares one request between concurrent saves of the same design (a modal Save and an Add to cart)', async () => {
    const first = saver.save(design());
    const second = saver.save(design({ source: 'cart' }));
    expect(calls).toHaveLength(1);
    finish(0);
    expect((await first).customizationId).toBe('cz-1');
    expect((await second).customizationId).toBe('cz-1');
    expect(saved).toHaveLength(1); // announced once, by the request that did the work
    expect(saved[0]).toEqual({
      customizationId: 'cz-1',
      templateId: 'tpl',
      templateVersion: 2,
      productId: 'p1',
      variantId: 'white',
      expiresAt: '2999-01-01T00:00:00Z',
      source: 'save',
    });
  });

  it('reuses a saved design until the line is reported added, then saves a new one', async () => {
    const first = saver.save(design());
    finish(0);
    await first;
    expect((await saver.save(design())).customizationId).toBe('cz-1');
    expect(calls).toHaveLength(1);
    saver.forget();
    const again = saver.save(design());
    expect(calls).toHaveLength(2);
    finish(1);
    expect((await again).customizationId).toBe('cz-2');
    expect(saved.map((s) => s.customizationId)).toEqual(['cz-1', 'cz-2']);
  });

  it('a result is available the moment its request ends: nothing can start a second save in between', async () => {
    const first = saver.save(design());
    finish(0);
    // The same turn in which the request settles: a caller that arrives now must find the saved design.
    await first.then(() => saver.save(design()));
    expect(calls).toHaveLength(1);
  });

  it('saves again for another design, variant or template version', async () => {
    saver.save(design());
    saver.save(design({ valuesKey: 'values-2' }));
    saver.save(design({ templateVersion: 3 }));
    context = { ...context, variantId: 'navy' };
    saver.save(design());
    expect(calls).toHaveLength(4);
  });

  it('does not reuse a design after its customization may have expired', async () => {
    const first = saver.save(design());
    calls[0].resolve({ customizationId: 'cz-1', expiresAt: new Date(Date.now() + 30_000).toISOString() }); // within the 60 s margin
    await first;
    saver.save(design());
    expect(calls).toHaveLength(2);
  });

  it('after a reset, a request that was still running neither is reused nor announced', async () => {
    const stale = saver.save(design());
    saver.reset(); // another product
    expect(calls[0].signal.aborted).toBe(true);
    finish(0);
    await stale;
    expect(saved).toHaveLength(0);
    saver.save(design());
    expect(calls).toHaveLength(2); // nothing from the old context is reused
  });

  it('a failed request is not remembered: the next attempt saves again', async () => {
    const first = saver.save(design());
    calls[0].reject(new Error('network'));
    await expect(first).rejects.toThrow('network');
    saver.save(design());
    expect(calls).toHaveLength(2);
    expect(saved).toHaveLength(0);
  });

  it('refuses to save before it is bound', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [DesignSaver, { provide: DesignPersister, useValue: {} }] });
    await expect(TestBed.inject(DesignSaver).save(design())).rejects.toThrow();
  });
});
