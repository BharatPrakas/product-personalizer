import { Service, Signal, computed, inject, signal } from '@angular/core';
import { ImageFieldSpec } from '../models/config.models';
import {
  CropRect,
  Customization,
  FieldError,
  FieldValue,
  ImageFitMode,
  ImageValue,
  QuarterTurns,
  TextValue,
} from '../models/draft.models';
import {
  ImagePlaceholderLayer,
  ProductConfig,
  ProductMockup,
  SourceSchemaVersion,
} from '../models/product.models';
import { MAX_ZOOM, MIN_ZOOM, defaultCrop, panCrop, zoomCrop, zoomOf } from '../util/crop-math';
import {
  DraftValues,
  buildCustomization,
  defaultValues,
  isImageValue,
  stableKey,
} from '../util/draft-utils';
import { uuid } from '../util/ids';
import {
  ActiveField,
  FieldGroup,
  ResolvedProduct,
  activeFields,
  groupFields,
  pickMockup,
  resolveProduct,
} from '../util/resolve';
import { Evaluation, ImageResolution, evaluateProduct } from '../util/scene';
import { AssetStore } from './asset-store.service';
import { UploadError } from './errors';
import { FontService } from './font.service';
import { ImageService } from './image.service';
import { LoadOutcome } from './load-pipeline.service';
import { PreviewComposite, RenderService } from './render.service';
import { SaveCoordinator } from './save-coordinator.service';

export type CustomizerStatus =
  | 'awaiting-config'
  | 'loading'
  | 'ready'
  | 'invalid-config'
  | 'asset-error'
  /** `product-id` has no published template mapped to it: the element renders only its fallback slot. */
  | 'not-personalizable';

export interface PhotoView {
  assetId: string;
  /** Size of the photo as the crop sees it (after rotation). */
  width: number;
  height: number;
  /** Destination aspect ratio (slot width / height). */
  aspect: number;
  crop: CropRect;
  zoom: number;
  bitmap: ImageBitmap;
  turns: 0 | 1 | 2 | 3;
  fit: ImageFitMode;
  resolution: ImageResolution | null;
}

/**
 * Instance-scoped draft state: the configuration, the chosen variant and artworks, field values,
 * local images and everything derived from them (resolved areas, active fields, scenes,
 * validation, dirty flag). One instance per custom element, provided by the component, so two
 * elements on a page never share a draft.
 *
 * Inactive values policy: values of fields that are not active for the current variant / artwork
 * stay in `values` (so switching back restores them) but are never rendered, validated or saved.
 */
@Service({ autoProvided: false })
export class StateService {
  private readonly render = inject(RenderService);
  private readonly fonts = inject(FontService);
  private readonly images = inject(ImageService);
  readonly assets = inject(AssetStore);

  readonly status = signal<CustomizerStatus>('awaiting-config');
  readonly config = signal<ProductConfig | null>(null);
  readonly sourceVersion = signal<SourceSchemaVersion>(2);
  readonly variantId = signal('');
  /** Explicit artwork choices per printable area. */
  readonly artworkSelection = signal<Readonly<Record<string, string>>>({});
  /** The view (mockup) the shopper asked to see; falls back to the first applicable one. */
  readonly requestedMockupId = signal<string | null>(null);
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
  /** Fields with an image being processed (independent per field). */
  readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Why the last upload for a field was rejected. */
  readonly uploadErrors = signal<Readonly<Record<string, string>>>({});
  /** Bumped by every shopper edit (not by load / restore / view changes). */
  readonly editCount = signal(0);

  /** `text` edits are debounced before `customizer-change`; everything else is immediate. */
  lastEditKind: 'text' | 'other' = 'other';

  private readonly fontFamilies = signal<ReadonlyMap<string, string>>(new Map());
  private readonly baselineKey = signal('');
  /** Invalidates in-flight uploads when the configuration is replaced. */
  private generation = 0;

  // ---- resolution (configuration -> what is active right now) --------------------------------

  readonly resolved = computed<ResolvedProduct | null>(() => {
    const config = this.config();
    return config ? resolveProduct(config, this.variantId(), this.artworkSelection()) : null;
  });

  readonly activeFields = computed<ActiveField[]>(() => {
    const config = this.config();
    const resolved = this.resolved();
    return config && resolved ? activeFields(config, resolved, this.values()) : [];
  });

  /** Shown fields grouped by printable area: what the form renders. */
  readonly groups = computed<FieldGroup[]>(() => {
    const resolved = this.resolved();
    return resolved ? groupFields(resolved, this.activeFields()) : [];
  });

  readonly mockup = computed<ProductMockup | null>(() => {
    const config = this.config();
    const resolved = this.resolved();
    return config && resolved ? pickMockup(config, resolved, this.requestedMockupId()) : null;
  });

  readonly evaluation = computed<Evaluation | null>(() => {
    const config = this.config();
    const resolved = this.resolved();
    if (!config || !resolved) return null;
    return evaluateProduct(
      {
        config,
        fontFamilies: this.fontFamilies(),
        staticImages: this.assets.staticImages(),
        localAssets: this.assets.localAssets(),
        measurer: this.render.measurer,
        missingGlyphs: this.fonts.missingGlyphs,
      },
      resolved,
      this.values(),
      { placeholders: true },
    );
  });

  /** Composite for every applicable mockup (the view picker, the exports). */
  readonly composites = computed<PreviewComposite[]>(() => {
    const config = this.config();
    const resolved = this.resolved();
    const evaluation = this.evaluation();
    const images = this.assets.staticImages();
    if (!config || !resolved || !evaluation) return [];
    const scenes = new Map(evaluation.areas.map((scene) => [scene.areaId, scene]));
    const out: PreviewComposite[] = [];
    for (const mockup of resolved.mockups) {
      const bitmap = images.get(mockup.src);
      if (!bitmap) continue;
      out.push({
        mockup,
        bitmap,
        background: config.preview?.background,
        areas: mockup.placements
          .filter((placement) => scenes.has(placement.printableAreaId))
          .map((placement) => ({ placement, scene: scenes.get(placement.printableAreaId)! })),
        overlays: (mockup.overlays ?? [])
          .map((overlay) => ({ overlay, bitmap: images.get(overlay.src) }))
          .filter(
            (entry): entry is { overlay: typeof entry.overlay; bitmap: ImageBitmap } =>
              !!entry.bitmap,
          ),
      });
    }
    return out;
  });

  /** The composite currently shown. */
  readonly composite = computed<PreviewComposite | null>(() => {
    const current = this.mockup();
    return this.composites().find((c) => c.mockup.id === current?.id) ?? null;
  });

  readonly errors = computed<FieldError[]>(() => this.evaluation()?.errors ?? []);
  readonly valid = computed(() => this.errors().length === 0);

  private readonly snapshotKey = computed(() =>
    stableKey({
      variantId: this.variantId(),
      artworkSelection: this.artworkSelection(),
      values: this.values(),
    }),
  );
  readonly dirty = computed(() => this.snapshotKey() !== this.baselineKey());

  readonly customization = computed<Customization | null>(() => {
    const config = this.config();
    const resolved = this.resolved();
    if (!config || !resolved) return null;
    return buildCustomization(config, this.sourceVersion(), resolved, this.activeFields(), {
      variantId: this.variantId(),
      artworkSelection: this.artworkSelection(),
      values: this.values(),
    });
  });

  /** True when anything differs from the template defaults (so Reset has something to do). */
  readonly differsFromDefaults = computed(() => {
    const config = this.config();
    if (!config) return false;
    return (
      stableKey(this.values()) !== stableKey(defaultValues(config)) ||
      Object.keys(this.artworkSelection()).length > 0
    );
  });

  readonly photoViews = computed<Readonly<Record<string, PhotoView>>>(() => {
    const views: Record<string, PhotoView> = {};
    const resolution = this.evaluation()?.resolution ?? {};
    for (const entry of this.activeFields()) {
      const { field } = entry;
      const value = this.values()[field.id];
      const layer = slotLayer(entry);
      if (field.type !== 'image' || !isImageValue(value) || value.assetId === null || !layer)
        continue;
      const asset = this.assets.localAssets().get(value.assetId);
      if (!asset) continue;
      const turns = (((value.rotation ?? 0) / 90) % 4) as 0 | 1 | 2 | 3;
      const width = turns % 2 === 1 ? asset.height : asset.width;
      const height = turns % 2 === 1 ? asset.width : asset.height;
      const aspect = layer.width / layer.height;
      const crop = value.crop ?? defaultCrop(width, height, aspect);
      views[field.id] = {
        assetId: asset.assetId,
        width,
        height,
        aspect,
        crop,
        zoom: zoomOf(crop, width, height, aspect),
        bitmap: asset.bitmap,
        turns,
        fit: value.fit ?? layer.fit ?? 'cover',
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
    this.variantId.set('');
    this.artworkSelection.set({});
    this.requestedMockupId.set(null);
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
    this.sourceVersion.set(outcome.sourceVersion);
    this.config.set(outcome.config);
    this.variantId.set(outcome.variantId);
    this.artworkSelection.set(outcome.artworkSelection);
    this.requestedMockupId.set(null);
    this.values.set(outcome.values);
    this.baselineKey.set(this.snapshotKey());
    this.lastEditKind = 'other';
    this.status.set('ready');
  }

  markSaved(snapshotKey: string): void {
    this.baselineKey.set(snapshotKey);
  }

  /** Key of the current draft, for `markSaved` after the host acknowledges. */
  currentKey(): string {
    return this.snapshotKey();
  }

  dispose(): void {
    this.generation++;
    this.assets.dispose();
  }

  // ---- edits -----------------------------------------------------------------------------

  setVariant(variantId: string): void {
    const config = this.config();
    if (this.locked() || !config || variantId === this.variantId()) return;
    if (!config.variants.some((v) => v.id === variantId)) return;
    this.variantId.set(variantId);
    this.lastEditKind = 'other';
    this.editCount.update((n) => n + 1);
  }

  setAreaArtwork(areaId: string, artworkId: string): void {
    const config = this.config();
    if (this.locked() || !config) return;
    const area = config.printableAreas.find((a) => a.id === areaId);
    if (!area || !area.artworkIds.includes(artworkId)) return;
    this.artworkSelection.update((selection) => ({ ...selection, [areaId]: artworkId }));
    this.lastEditKind = 'other';
    this.editCount.update((n) => n + 1);
  }

  /** Switching the shown view changes nothing in the design, so it is not an edit. */
  setMockup(mockupId: string): void {
    this.requestedMockupId.set(mockupId);
  }

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
    const layer = this.slotFor(fieldId);
    const field = this.config()?.fields.find((f) => f.id === fieldId);
    if (this.locked() || !layer || field?.type !== 'image' || this.busy().has(fieldId)) return;
    const generation = this.generation;
    this.setBusy(fieldId, true);
    this.setUploadError(fieldId, null);
    try {
      const processed = await this.images.processUpload(file, {
        accept: (field as ImageFieldSpec).accept,
        maxBytes: (field as ImageFieldSpec).maxBytes,
      });
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

  /** `cover` fills the slot (cropping); `contain` shows the whole photo inside it. */
  setImageFit(fieldId: string, fit: ImageFitMode): void {
    const current = this.values()[fieldId];
    if (this.locked() || !isImageValue(current) || current.assetId === null) return;
    this.edit(fieldId, { ...current, fit });
  }

  /** Turn the photo a quarter turn clockwise; the crop restarts centred for the new orientation. */
  rotateImage(fieldId: string): void {
    const view = this.photoViews()[fieldId];
    const current = this.values()[fieldId];
    if (this.locked() || !view || !isImageValue(current) || current.assetId === null) return;
    const rotation = (((current.rotation ?? 0) + 90) % 360) as QuarterTurns;
    const turned: ImageValue = { ...current, rotation };
    const asset = this.assets.localAssets().get(current.assetId);
    if (!asset) return;
    const odd = rotation % 180 === 90;
    turned.crop = defaultCrop(
      odd ? asset.height : asset.width,
      odd ? asset.width : asset.height,
      view.aspect,
    );
    if (rotation === 0) delete turned.rotation;
    this.edit(fieldId, turned);
  }

  /** Restore every input to the template defaults and release local images. */
  resetAll(): void {
    const config = this.config();
    if (this.locked() || !config) return;
    this.generation++; // an upload still being processed must not bring its photo back
    this.busy.set(new Set());
    this.assets.clearLocal();
    this.values.set(defaultValues(config));
    this.artworkSelection.set({});
    this.touched.set(new Set());
    this.uploadErrors.set({});
    this.lastEditKind = 'other';
    this.editCount.update((n) => n + 1);
  }

  // ---- internals -------------------------------------------------------------------------

  private setCrop(fieldId: string, crop: CropRect): void {
    const current = this.values()[fieldId];
    if (!isImageValue(current) || current.assetId === null) return;
    this.edit(fieldId, { ...current, crop });
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

  /** The first slot fed by `fieldId`: active ones first, then any in the configuration. */
  private slotFor(fieldId: string): ImagePlaceholderLayer | null {
    const active = this.activeFields().find((entry) => entry.field.id === fieldId);
    const fromActive = active ? slotLayer(active) : null;
    if (fromActive) return fromActive;
    for (const artwork of this.config()?.artworks ?? []) {
      for (const layer of artwork.layers) {
        if (layer.type === 'image-placeholder' && layer.fieldId === fieldId) return layer;
      }
    }
    return null;
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

function slotLayer(entry: ActiveField): ImagePlaceholderLayer | null {
  const binding = entry.bindings.find((b) => b.layer.type === 'image-placeholder');
  return binding?.layer.type === 'image-placeholder' ? binding.layer : null;
}
