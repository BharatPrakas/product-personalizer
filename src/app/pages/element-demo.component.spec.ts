import { Component, input, output } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { ElementDemoComponent } from './element-demo.component';
import { Customization } from '../customizer/models';
import {
  CustomizerChangeDetail,
  CustomizerErrorDetail,
  CustomizerReadyDetail,
  CustomizerSaveDetail,
  SaveResult,
} from '../customizer/models/events.models';
import { ProductCustomizerComponent } from '../customizer/product-customizer.component';

/** Same public inputs/outputs as the real component, none of its canvas and network behaviour. */
@Component({ selector: 'app-product-customizer', template: '' })
class StubCustomizer {
  readonly configUrl = input<string | null>(null);
  readonly disabled = input(false);
  readonly saveResult = input<SaveResult | null>(null);
  readonly initialCustomization = input<Customization | null>(null);
  readonly assetMap = input<ReadonlyMap<string, Blob> | null>(null);
  readonly ready = output<CustomizerReadyDetail>({ alias: 'customizer-ready' });
  readonly change = output<CustomizerChangeDetail>({ alias: 'customizer-change' });
  readonly save = output<CustomizerSaveDetail>({ alias: 'customizer-save' });
  readonly error = output<CustomizerErrorDetail>({ alias: 'customizer-error' });
}

const saveDetail = (
  requestId: string,
  assets: CustomizerSaveDetail['assets'] = [],
): CustomizerSaveDetail => ({
  requestId,
  customization: {
    schemaVersion: 1,
    productId: 'p',
    templateId: 't',
    templateVersion: 1,
    values: {},
    canvas: { width: 1, height: 1, background: 'transparent' },
  },
  previewBlob: new Blob(['p']),
  artworks: [],
  previews: [],
  artworkBlob: new Blob(['a']),
  assets,
});

describe('demo host (ElementDemoComponent)', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({ imports: [ElementDemoComponent] })
      .overrideComponent(ElementDemoComponent, {
        remove: { imports: [ProductCustomizerComponent] },
        add: { imports: [StubCustomizer] },
      })
      .compileComponents();
    const fixture = TestBed.createComponent(ElementDemoComponent);
    fixture.detectChanges();
    const stub = fixture.debugElement.query(By.directive(StubCustomizer))
      .componentInstance as StubCustomizer;
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
    };
    return {
      fixture,
      stub,
      settle,
      app: fixture.componentInstance as unknown as Record<string, any>,
    };
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('offers the v1 samples and the v2 products, starting on the tote', async () => {
    const { fixture, stub } = await setup();
    const labels = [...fixture.nativeElement.querySelectorAll('input[name="sample"]')].map(
      (i: HTMLInputElement) => i.parentElement!.textContent!.trim(),
    );
    expect(labels).toEqual([
      'T-shirt: text only',
      'Tote: name + photo',
      'Poster: text + artwork',
      'v2 Heart clock (3 areas, 10 uploads)',
      'v2 T-shirt (front + back)',
      'v2 Bottle (label, back, cap)',
    ]);
    expect(stub.configUrl()).toBe('data/tote-photo.json');
  });

  it('acknowledges a save with success after the simulated delay, using the same request id and a "prepared in demo" message', async () => {
    const { stub, settle } = await setup();
    stub.save.emit(saveDetail('req-1'));
    expect(stub.saveResult()).toBeNull();
    vi.advanceTimersByTime(600);
    await settle();
    expect(stub.saveResult()).toEqual({
      requestId: 'req-1',
      status: 'success',
      message: expect.stringContaining('Prepared in demo'),
    });
    expect(stub.saveResult()!.message).toContain('Nothing was sent to a server');
  });

  it('can simulate a failing host, and a host that never answers', async () => {
    const { stub, settle, app } = await setup();
    app['hostMode'].set('error');
    stub.save.emit(saveDetail('req-err'));
    vi.advanceTimersByTime(600);
    await settle();
    expect(stub.saveResult()).toMatchObject({ requestId: 'req-err', status: 'error' });

    app['hostMode'].set('silent');
    stub.save.emit(saveDetail('req-silent'));
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(stub.saveResult()).toMatchObject({ requestId: 'req-err' }); // unchanged: never answered
  });

  it('de-duplicates a retry on its request id', async () => {
    const { stub, settle, app } = await setup();
    stub.save.emit(saveDetail('same'));
    stub.save.emit(saveDetail('same'));
    vi.advanceTimersByTime(600);
    await settle();
    expect(app['log']().some((line: string) => line.includes('de-duplicated'))).toBe(true);
    expect(app['prepared'].size).toBe(1);
  });

  it('restores the last prepared design with an asset map built from the saved Blobs', async () => {
    const { stub, settle, app } = await setup();
    const blob = new Blob(['image']);
    stub.save.emit(
      saveDetail('req-restore', [
        { assetId: 'local-1', blob, mimeType: 'image/png', width: 2, height: 2 },
      ]),
    );
    vi.advanceTimersByTime(600);
    await settle();
    app['restore']();
    await settle();
    expect(stub.initialCustomization()).toEqual(saveDetail('x').customization);
    expect(stub.assetMap()!.get('local-1')).toBe(blob);
  });

  it('asks before replacing a product that has unsaved changes, using the dirty flag from change events', async () => {
    const { stub, settle, app } = await setup();
    stub.change.emit({
      draft: saveDetail('x').customization,
      valid: true,
      dirty: true,
      errors: [],
    });
    const ask = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    app['select'](app['samples'][2]);
    await settle();
    expect(ask).toHaveBeenCalledOnce();
    expect(stub.configUrl()).toBe('data/tote-photo.json'); // declined: unchanged

    ask.mockReturnValue(true);
    app['select'](app['samples'][2]);
    await settle();
    expect(stub.configUrl()).toBe('data/poster-artwork.json');
    expect(stub.initialCustomization()).toBeNull();
  });
});
