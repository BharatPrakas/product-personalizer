import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import toteJson from '../../../../public/data/tote-photo.json';
import { ProductConfig } from '../models/product.models';
import { upgradeV1 } from '../util/config-upgrade';
import { TextValue } from '../models/draft.models';
import { validateConfig } from '../util/config-validator';
import { defaultValues, stableKey } from '../util/draft-utils';
import { resolveBase } from '../util/url-policy';
import { AssetStore } from './asset-store.service';
import { FontService } from './font.service';
import { ImageService } from './image.service';
import { RenderService } from './render.service';
import { LoadOutcome } from './load-pipeline.service';
import { SaveCoordinator } from './save-coordinator.service';
import { StateService } from './state.service';

function load(): ProductConfig {
  const result = validateConfig(JSON.parse(JSON.stringify(toteJson)), {
    resolvedBase: resolveBase({
      configUrl: 'https://shop.example/c/data/x.json',
      baseUrl: null,
      documentBase: 'https://shop.example/',
    }),
    policy: { pageOrigin: 'https://shop.example', allowedOrigins: [] },
  });
  if (!result.ok) throw new Error('fixture invalid');
  return upgradeV1(result.config);
}

const ready = (
  config: ProductConfig,
  values = defaultValues(config),
): Extract<LoadOutcome, { kind: 'ready' }> => ({
  kind: 'ready',
  config,
  sourceVersion: 1,
  variantId: config.variants[0].id,
  artworkSelection: {},
  fontFamilies: new Map(config.fonts.map((f) => [f.id, `zb-${f.id}`])),
  staticImages: new Map(
    config.fields.flatMap((f) =>
      f.type === 'artwork'
        ? f.choices.map(
            (c) =>
              [
                c.src,
                { width: 256, height: 256, close: () => undefined } as unknown as ImageBitmap,
              ] as const,
          )
        : [],
    ),
  ),
  values,
  localAssets: [],
  notices: [],
});

/** jsdom has no canvas: text measurement and glyph probing are stubbed (their real behaviour is covered in the browser tests). */
const fakeRender = {
  measurer: {
    ink: (_font: string, _align: string, text: string) => ({
      left: text.length * 5,
      right: text.length * 5,
      ascent: 10,
      descent: 2,
    }),
    width: (_font: string, text: string) => text.length * 10,
  },
};
const fakeFonts = { missingGlyphs: () => [] as string[] };

/** What each <zb-product-customizer> element gets: its own set of instance services. */
function instance(images: Partial<ImageService> = {}): {
  state: StateService;
  save: SaveCoordinator;
  assets: AssetStore;
} {
  const injector = Injector.create({
    providers: [
      { provide: ImageService, useValue: images },
      { provide: RenderService, useValue: fakeRender },
      { provide: FontService, useValue: fakeFonts },
      AssetStore,
      StateService,
      SaveCoordinator,
    ],
    parent: TestBed.inject(Injector),
  });
  return {
    state: injector.get(StateService),
    save: injector.get(SaveCoordinator),
    assets: injector.get(AssetStore),
  };
}

describe('instance isolation (F15)', () => {
  it('two instances never share a draft, dirty flag, errors or save state', () => {
    const config = load();
    const a = instance();
    const b = instance();
    a.state.commit(ready(config));
    b.state.commit(ready(config));

    a.state.setText('name', { text: 'Alex' });
    a.state.setArtwork('motif', 'star');

    expect((a.state.values()['name'] as TextValue).text).toBe('Alex');
    expect((b.state.values()['name'] as TextValue).text).toBe('');
    expect(a.state.dirty()).toBe(true);
    expect(b.state.dirty()).toBe(false);
    expect(a.state.errors().map((e) => e.fieldId)).toEqual(['photo']);
    expect(b.state.errors().map((e) => e.fieldId)).toEqual(['name', 'photo']);

    a.save.state.set('awaiting-host');
    expect(b.save.state()).toBe('idle');
    expect(a.state).not.toBe(b.state);
    expect(a.assets).not.toBe(b.assets);
  });

  it('disposing one instance leaves the other fully working', () => {
    const config = load();
    const a = instance();
    const b = instance();
    a.state.commit(ready(config));
    b.state.commit(ready(config));
    a.state.dispose();
    b.state.setText('name', { text: 'Still here' });
    expect((b.state.values()['name'] as TextValue).text).toBe('Still here');
    expect(b.state.status()).toBe('ready');
  });
});

describe('StateService edits', () => {
  const setup = () => {
    const { state } = instance();
    state.commit(ready(load()));
    return state;
  };

  it('normalises typed text to NFC and tracks dirty against the loaded draft', () => {
    const state = setup();
    expect(state.dirty()).toBe(false);
    state.setText('name', { text: 'e\u{301}' });
    expect((state.values()['name'] as TextValue).text).toBe('é');
    expect(state.dirty()).toBe(true);
    state.setText('name', { text: '' });
    expect(state.dirty()).toBe(false);
  });

  it('only a text edit is debounced; font, colour and artwork changes are immediate', () => {
    const state = setup();
    state.setText('name', { text: 'A' });
    expect(state.lastEditKind).toBe('text');
    state.setText('name', { fontId: 'serif' });
    expect(state.lastEditKind).toBe('other');
    state.setArtwork('motif', 'moon');
    expect(state.lastEditKind).toBe('other');
  });

  it('ignores edits while the host has disabled the element', () => {
    const { state } = instance();
    state.commit(ready(load()));
    const disabled = signal(false);
    state.bindHostDisabled(disabled);
    disabled.set(true);
    state.setText('name', { text: 'Nope' });
    state.setArtwork('motif', 'star');
    expect((state.values()['name'] as TextValue).text).toBe('');
    expect(state.dirty()).toBe(false);
    disabled.set(false);
    state.setText('name', { text: 'Yes' });
    expect((state.values()['name'] as TextValue).text).toBe('Yes');
  });

  it('locks in the same tick the save protocol starts: no edit can slip in after the Save click', () => {
    const { state, save } = instance();
    state.commit(ready(load()));
    expect(state.locked()).toBe(false);
    save.state.set('exporting'); // what SaveCoordinator.start does synchronously on click
    expect(state.locked()).toBe(true);
    state.setText('name', { text: 'late' });
    state.panImage('photo', 0.1, 0);
    state.resetAll();
    expect((state.values()['name'] as TextValue).text).toBe('');
    save.state.set('awaiting-host');
    expect(state.locked()).toBe(true);
    save.state.set('host-error');
    expect(state.locked()).toBe(false);
  });

  it('is locked until a configuration is ready', () => {
    const { state } = instance();
    expect(state.locked()).toBe(true); // awaiting-config
    state.beginLoad();
    expect(state.locked()).toBe(true); // loading
  });

  it('marks the saved draft as the new baseline (host success clears dirty)', () => {
    const state = setup();
    state.setText('name', { text: 'Alex' });
    expect(state.dirty()).toBe(true);
    state.markSaved(state.currentKey());
    expect(state.dirty()).toBe(false);
    state.setText('name', { text: 'Alexa' });
    expect(state.dirty()).toBe(true);
  });

  it('reset restores template defaults and counts as an edit', () => {
    const state = setup();
    state.setText('name', { text: 'Alex', color: '#111827' });
    state.setArtwork('motif', 'leaf');
    const edits = state.editCount();
    expect(state.differsFromDefaults()).toBe(true);
    state.resetAll();
    expect(state.values()).toEqual(defaultValues(load()));
    expect(state.differsFromDefaults()).toBe(false);
    expect(state.editCount()).toBe(edits + 1);
  });

  it('beginLoad discards the previous product entirely', () => {
    const state = setup();
    state.setText('name', { text: 'Alex' });
    state.beginLoad();
    expect(state.status()).toBe('loading');
    expect(state.config()).toBeNull();
    expect(state.values()).toEqual({});
    expect(state.evaluation()).toBeNull();
  });
});

describe('photo upload racing with other edits', () => {
  const canonical = () => ({
    blob: new Blob(['x'], { type: 'image/png' }),
    mimeType: 'image/png' as const,
    width: 1800,
    height: 1200,
    bitmap: { width: 1800, height: 1200, close: vi.fn() } as unknown as ImageBitmap,
  });

  function setupUpload() {
    let finish!: (value: ReturnType<typeof canonical>) => void;
    const processing = new Promise<ReturnType<typeof canonical>>((resolve) => (finish = resolve));
    const ctx = instance({ processUpload: () => processing });
    ctx.state.commit(ready(load()));
    return { ...ctx, finish };
  }

  it('a photo that finishes processing after Reset does not come back, and its bitmap is released', async () => {
    const { state, assets, finish } = setupUpload();
    const upload = state.uploadImage('photo', new Blob(['x']));
    expect(state.busy().has('photo')).toBe(true);
    state.resetAll();
    expect(state.busy().size).toBe(0);
    const image = canonical();
    finish(image);
    await upload;
    expect(state.values()['photo']).toEqual({ assetId: null, crop: null });
    expect(assets.localAssets().size).toBe(0);
    expect(image.bitmap.close).toHaveBeenCalledOnce();
    expect(state.busy().size).toBe(0);
  });

  it('a photo that finishes after the host disabled editing is discarded', async () => {
    const { state, assets, finish } = setupUpload();
    const disabled = signal(false);
    state.bindHostDisabled(disabled);
    const upload = state.uploadImage('photo', new Blob(['x']));
    disabled.set(true);
    const image = canonical();
    finish(image);
    await upload;
    expect(state.values()['photo']).toEqual({ assetId: null, crop: null });
    expect(assets.localAssets().size).toBe(0);
    expect(image.bitmap.close).toHaveBeenCalledOnce();
    expect(state.busy().size).toBe(0);
  });

  it('a normal upload still lands, with the default crop', async () => {
    const { state, assets, finish } = setupUpload();
    const upload = state.uploadImage('photo', new Blob(['x']));
    finish(canonical());
    await upload;
    const value = state.values()['photo'] as unknown as { assetId: string; crop: number[] };
    expect(value.assetId).toMatch(/^local-/);
    expect(assets.localAssets().has(value.assetId)).toBe(true);
    expect(value.crop[2]).toBeCloseTo(2 / 3);
  });
});
