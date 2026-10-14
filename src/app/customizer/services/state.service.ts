import { Service, Signal, computed, inject, signal } from '@angular/core';
import { CustomizerConfig, ImageLayerSpec } from '../models/config.models';
import { CropRect, Customization, FieldError, FieldValue, TextValue } from '../models/draft.models';
import { MAX_ZOOM, MIN_ZOOM, defaultCrop, panCrop, zoomCrop, zoomOf } from '../util/crop-math';
import { uuid } from '../util/ids';
import {
  DraftValues,
  buildCustomization,
  defaultValues,
  isImageValue,
  stableKey,
} from '../util/draft-utils';
import { Evaluation, ImageResolution, evaluateDraft } from '../util/scene';
import { AssetStore } from './asset-store.service';
import { UploadError } from './errors';
import { FontService } from './font.service';
import { ImageService } from './image.service';
import { LoadOutcome } from './load-pipeline.service';
import { RenderService } from './render.service';
import { SaveCoordinator } from './save-coordinator.service';

export type CustomizerStatus =
  'awaiting-config' | 'loading' | 'ready' | 'invalid-config' | 'asset-error';

export interface PhotoView {
  assetId: string;
  width: number;
  height: number;
  /** Destination aspect ratio (layer width / height). */
  aspect: number;
  crop: CropRect;
  zoom: number;
  bitmap: ImageBitmap;
  resolution: ImageResolution | null;
}

/**
 * Instance-scoped draft state: the configuration, field values, local images and everything
 * derived from them (scene, validation, dirty flag). One instance per custom element, provided
 * by the component, so two elements on a page never share a draft.
 */
@Service({ autoProvided: false })
export class StateService {
  private readonly render = inject(RenderService);
  private readonly fonts = inject(FontService);
  private readonly images = inject(ImageService);
  readonly assets = inject(AssetStore);

  readonly status = signal<CustomizerStatus>('awaiting-config');
  readonly config = signal<CustomizerConfig | null>(null);
  readonly values = signal<DraftValues>({});
  private readonly save = inject(SaveCoordinator);
  private readonly hostDisabled = signal<Signal<boolean> | null>(null);
  /**
   * No edits while loading, exporting / awaiting the host, or disabled by the host. A computed (not a
   * mirrored flag) so a Save click locks the draft in the same tick, before any other event handler runs.
   */
  readonly locked = computed(
    () => (this.hostDisabled()?.() ?? false) || this.save.locked() || this.status() !== 'ready',
  );
  readonly touched = signal<ReadonlySet<string>>(new Set());
  /** Fields with an image being processed. */
  readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Why the last upload for a field was rejected. */
  readonly uploadErrors = signal<Readonly<Record<string, string>>>({});
  /** Bumped by every shopper edit (not by load / restore). */
  readonly editCount = signal(0);

  /** `text` edits are debounced before `customizer-change`; everything else is immediate. */
  lastEditKind: 'text' | 'other' = 'other';

  private readonly fontFamilies = signal<ReadonlyMap<string, string>>(new Map());
  private readonly baselineKey = signal('');
  /** Invalidates in-flight uploads when the configuration is replaced. */
  private generation = 0;

  readonly evaluation = computed<Evaluation | null>(() => {
    const config = this.config();
    if (!config) return null;
    return evaluateDraft(
      {
        config,
        fontFamilies: this.fontFamilies(),
        staticImages: this.assets.staticImages(),
        localAssets: this.assets.localAssets(),
        measure: this.render.measure,
        missingGlyphs: this.fonts.missingGlyphs,
      },
      this.values(),
    );
  });

  readonly errors = computed<FieldError[]>(() => this.evaluation()?.errors ?? []);
  readonly valid = computed(() => this.errors().length === 0);
  readonly dirty = computed(() => stableKey(this.values()) !== this.baselineKey());

  readonly customization = computed<Customization | null>(() => {
    const config = this.config();
    return config ? buildCustomization(config, this.values()) : null;
  });

  /** True when any field differs from the template defaults (so Reset has something to do). */
  readonly differsFromDefaults = computed(() => {
    const config = this.config();
    return config ? stableKey(this.values()) !== stableKey(defaultValues(config)) : false;
  });

  readonly mockup = computed(() => {
    const config = this.config();
    return config ? (this.assets.staticImages().get(config.mockup.src) ?? null) : null;
  });

  readonly photoViews = computed<Readonly<Record<string, PhotoView>>>(() => {
    const config = this.config();
    if (!config) return {};
    const views: Record<string, PhotoView> = {};
    const resolution = this.evaluation()?.resolution ?? {};
    for (const field of config.fields) {
      const value = this.values()[field.id];
      const layer = this.imageLayer(field.id);
      if (field.type !== 'image' || !isImageValue(value) || value.assetId === null || !layer)
        continue;
      const asset = this.assets.localAssets().get(value.assetId);
      if (!asset) continue;
      const aspect = layer.width / layer.height;
      const crop = value.crop ?? defaultCrop(asset.width, asset.height, aspect);
      views[field.id] = {
        assetId: asset.assetId,
        width: asset.width,
        height: asset.height,
        aspect,
        crop,
        zoom: zoomOf(crop, asset.width, asset.height, aspect),
        bitmap: asset.bitmap,
        resolution: resolution[field.id] ?? null,
      };
    }
    return views;
  });

  // ---- lifecycle -------------------------------------------------------------------------

  /** The component hands over its `disabled` input so `locked` follows it without a change-detection lag. */
  bindHostDisabled(disabled: Signal<boolean>): void {
    this.hostDisabled.set(disabled);
  }

  /** A new load is starting: discard the previous product's draft and images. */
  beginLoad(): void {
    this.generation++;
    this.assets.dispose();
    this.config.set(null);
    this.values.set({});
    this.fontFamilies.set(new Map());
    this.touched.set(new Set());
    this.busy.set(new Set());
    this.uploadErrors.set({});
    this.baselineKey.set('');
    this.status.set('loading');
  }

  setStatus(status: CustomizerStatus): void {
    if (status !== 'ready') {
      this.generation++;
      this.assets.dispose();
      this.config.set(null);
      this.values.set({});
    }
    this.status.set(status);
  }

  commit(outcome: Extract<LoadOutcome, { kind: 'ready' }>): void {
    this.assets.dispose();
    this.assets.staticImages.set(outcome.staticImages);
    for (const asset of outcome.localAssets) this.assets.addLocal(asset);
    this.fontFamilies.set(outcome.fontFamilies);
    this.config.set(outcome.config);
    this.values.set(outcome.values);
    this.baselineKey.set(stableKey(outcome.values));
    this.lastEditKind = 'other';
    this.status.set('ready');
  }

  markSaved(valuesKey: string): void {
    this.baselineKey.set(valuesKey);
  }

  dispose(): void {
    this.generation++;
    this.assets.dispose();
  }

  // ---- edits -----------------------------------------------------------------------------

  setText(fieldId: string, patch: Partial<TextValue>): void {
    const current = this.values()[fieldId];
    if (this.locked() || !current || !('text' in current)) return;
    const next: TextValue = { ...current, ...patch };
    if (patch.text !== undefined) next.text = patch.text.normalize('NFC');
    this.edit(fieldId, next, patch.text !== undefined ? 'text' : 'other');
  }

  setArtwork(fieldId: string, choiceId: string | null): void {
    if (this.locked()) return;
    this.edit(fieldId, { choiceId });
  }

  touch(fieldId: string): void {
    if (this.touched().has(fieldId)) return;
    this.touched.update((set) => new Set(set).add(fieldId));
  }

  async uploadImage(fieldId: string, file: Blob): Promise<void> {
    const layer = this.imageLayer(fieldId);
    if (this.locked() || !layer || this.busy().has(fieldId)) return;
    const generation = this.generation;
    this.setBusy(fieldId, true);
    this.setUploadError(fieldId, null);
    try {
      const processed = await this.images.processUpload(file);
      // Discard the result if the product changed, the form was reset, or editing was locked meanwhile.
      if (generation !== this.generation || this.locked()) {
        processed.bitmap.close();
        return;
      }
      const assetId = `local-${uuid()}`;
      const previous = this.currentAssetId(fieldId);
      this.assets.addLocal({ assetId, ...processed });
      const crop = defaultCrop(processed.width, processed.height, layer.width / layer.height);
      this.edit(fieldId, { assetId, crop });
      if (previous) this.assets.removeLocal(previous);
    } catch (error) {
      if (generation === this.generation) {
        this.setUploadError(
          fieldId,
          error instanceof UploadError
            ? error.message
            : 'The photo could not be processed. Try another file.',
        );
      }
    } finally {
      if (generation === this.generation) this.setBusy(fieldId, false);
    }
  }

  removeImage(fieldId: string): void {
    if (this.locked()) return;
    const previous = this.currentAssetId(fieldId);
    this.setUploadError(fieldId, null);
    this.edit(fieldId, { assetId: null, crop: null });
    if (previous) this.assets.removeLocal(previous);
  }

  /** Pan by fractions of the current crop size (positive moves the window right / down). */
  panImage(fieldId: string, dx: number, dy: number): void {
    const view = this.photoViews()[fieldId];
    if (this.locked() || !view) return;
    this.setCrop(fieldId, panCrop(view.crop, dx, dy));
  }

  zoomImage(fieldId: string, zoom: number): void {
    const view = this.photoViews()[fieldId];
    if (this.locked() || !view) return;
    this.setCrop(
      fieldId,
      zoomCrop(
        view.crop,
        Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM),
        view.width,
        view.height,
        view.aspect,
      ),
    );
  }

  resetCrop(fieldId: string): void {
    const view = this.photoViews()[fieldId];
    if (this.locked() || !view) return;
    this.setCrop(fieldId, defaultCrop(view.width, view.height, view.aspect));
  }

  /** Restore every input to the template defaults and release local images. */
  resetAll(): void {
    const config = this.config();
    if (this.locked() || !config) return;
    this.generation++; // an upload still being processed must not bring its photo back
    this.busy.set(new Set());
    this.assets.clearLocal();
    this.values.set(defaultValues(config));
    this.touched.set(new Set());
    this.uploadErrors.set({});
    this.lastEditKind = 'other';
    this.editCount.update((n) => n + 1);
  }

  // ---- internals -------------------------------------------------------------------------

  private setCrop(fieldId: string, crop: CropRect): void {
    const current = this.values()[fieldId];
    if (!isImageValue(current) || current.assetId === null) return;
    this.edit(fieldId, { assetId: current.assetId, crop });
  }

  private edit(fieldId: string, value: FieldValue, kind: 'text' | 'other' = 'other'): void {
    this.lastEditKind = kind;
    this.values.update((values) => ({ ...values, [fieldId]: value }));
    this.editCount.update((n) => n + 1);
  }

  private currentAssetId(fieldId: string): string | null {
    const value = this.values()[fieldId];
    return isImageValue(value) ? value.assetId : null;
  }

  private imageLayer(fieldId: string): ImageLayerSpec | null {
    const layer = this.config()?.layers.find((l) => l.type === 'image' && l.fieldId === fieldId);
    return layer?.type === 'image' ? layer : null;
  }

  private setBusy(fieldId: string, on: boolean): void {
    this.busy.update((set) => {
      const next = new Set(set);
      if (on) next.add(fieldId);
      else next.delete(fieldId);
      return next;
    });
  }

  private setUploadError(fieldId: string, message: string | null): void {
    this.uploadErrors.update((errors) => {
      const next = { ...errors };
      if (message) next[fieldId] = message;
      else delete next[fieldId];
      return next;
    });
  }
}
