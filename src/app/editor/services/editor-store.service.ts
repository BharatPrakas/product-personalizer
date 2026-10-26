import { Service, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { ConfigIssue } from '../../customizer/models/config.models';
import {
  AreaPlacement,
  ArtworkLayer,
  PrintableArea,
  ProductConfig,
  ProductMockup,
  ShapeSpec,
} from '../../customizer/models/product.models';
import { AssetStore } from '../../customizer/services/asset-store.service';
import { ExportService } from '../../customizer/services/export.service';
import { FontService } from '../../customizer/services/font.service';
import { ImageService } from '../../customizer/services/image.service';
import { PreviewComposite, RenderService } from '../../customizer/services/render.service';
import { DraftValues, defaultValues } from '../../customizer/util/draft-utils';
import { ResolvedProduct, resolveProduct } from '../../customizer/util/resolve';
import { Evaluation, LocalAsset, evaluateProduct } from '../../customizer/util/scene';
import { I18n } from '../../admin/i18n/i18n.service';
import { ToastService } from '../../ui/toast.service';
import {
  ConfigurationConflictError,
  ConfigurationInvalidError,
  ConfigurationRepository,
  StorageError,
} from '../../workspace/configuration-repository';
import { ConfigurationRecord, hasUnpublishedChanges } from '../../workspace/configuration.models';
import { ConfigurationTransferService } from '../../workspace/configuration-transfer.service';
import { SetupStep, canPublish, setupSteps } from '../../workspace/publish-readiness';
import { ImageUploadService } from '../../workspace/image-upload.service';
import { validateConfiguration } from '../../workspace/validation';
import * as edit from '../util/config-edit';
import { downloadBlob, safeFilename } from '../util/download';
import { assetBaseUrl } from '../../workspace/asset-base';

export type StageView = 'mockup' | 'artwork';

export type Selection =
  | { kind: 'product' }
  | { kind: 'variant'; id: string }
  | { kind: 'mockup'; id: string }
  | { kind: 'area'; id: string }
  | { kind: 'artwork'; id: string }
  | { kind: 'layer'; id: string };

/** `draw` creates a printable area of the given shape by dragging on the mockup. */
export type Tool = { kind: 'select' } | { kind: 'pan' } | { kind: 'draw'; shape: ShapeSpec };

export type SidebarTab = 'mockups' | 'areas' | 'artworks' | 'layers' | 'markups';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAMPLE_PHOTOS = ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5', 'photo-6'];
const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

/**
 * Working state of the merchant editor for one configuration: the raw configuration (what is saved),
 * undo / redo, selection, the validated copy the renderer uses, loaded images and fonts, and the
 * scenes drawn on the stage. Provided by the editor page, so each editor session is independent.
 */
@Service({ autoProvided: false })
export class EditorStore {
  private readonly repo = inject(ConfigurationRepository);
  private readonly transfer = inject(ConfigurationTransferService);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(I18n);
  private readonly uploads = inject(ImageUploadService);
  private readonly images = inject(ImageService);
  private readonly fonts = inject(FontService);
  private readonly render = inject(RenderService);
  private readonly exporter = inject(ExportService);
  readonly assets = inject(AssetStore);

  // ---- configuration + history -----------------------------------------------------------------

  readonly config = signal<ProductConfig | null>(null);
  private readonly saved = signal<ProductConfig | null>(null);
  /** The stored record (draft + published snapshot) this editor session was opened from. */
  readonly record = signal<ConfigurationRecord | null>(null);
  readonly saveState = signal<SaveState>('idle');
  /** Where saves go, in words the merchant can trust (never overstates persistence). */
  readonly storageLabel = computed(() => this.i18n.t(this.repo.storage().labelKey));
  /** Set when saves cannot survive a reload (browser storage unavailable). */
  readonly storageWarning = computed(() => {
    const info = this.repo.storage();
    return info.persistent ? null : this.i18n.t(info.labelKey);
  });
  readonly saveError = signal<string | null>(null);
  readonly publishing = signal(false);
  private past: ProductConfig[] = [];
  private future: ProductConfig[] = [];
  private readonly historyTick = signal(0);
  private lastEdit = { key: '', time: 0 };

  readonly canUndo = computed(() => (this.historyTick(), this.past.length > 0));
  readonly canRedo = computed(() => (this.historyTick(), this.future.length > 0));
  readonly dirty = computed(() => this.config() !== this.saved());

  /** Published once, and the working draft has moved on since. */
  readonly unpublishedChanges = computed(() => {
    const record = this.record();
    const config = this.config();
    return !!record && !!config && hasUnpublishedChanges({ ...record, draft: config });
  });
  readonly published = computed(() => this.record()?.published ?? null);

  // ---- validation + the copy the renderer uses ----------------------------------------------------

  /** Drafts may be incomplete; structural problems still block saving. */
  readonly validation = computed(() => {
    const config = this.config();
    return config ? validateConfiguration(config, { allowIncomplete: true }) : null;
  });
  private readonly strictIssues = computed<ConfigIssue[]>(() => {
    const config = this.config();
    if (!config) return [];
    const strict = validateConfiguration(config, { allowIncomplete: false });
    return strict.ok ? [] : strict.issues;
  });
  /** The guided setup, which doubles as the publish checklist. */
  readonly steps = computed<SetupStep[]>(() => {
    const config = this.config();
    return config ? setupSteps(config, this.strictIssues()) : [];
  });
  readonly publishable = computed(() => canPublish(this.steps()));
  /** The customer preview needs a configuration the storefront accepts. */
  readonly previewable = computed(() => {
    const config = this.config();
    return !!config && config.mockups.length > 0 && this.strictIssues().length === 0;
  });
  readonly issues = computed<ConfigIssue[]>(() => {
    const v = this.validation();
    return v && !v.ok ? v.issues : [];
  });
  /** Last configuration that validated: every `src` absolute. Rendering never sees an invalid one. */
  readonly resolvedConfig = linkedSignal<
    ReturnType<EditorStore['validation']>,
    ProductConfig | null
  >({
    source: this.validation,
    computation: (v, previous) => (v && v.ok ? v.config : (previous?.value ?? null)),
  });

  // ---- view state ----------------------------------------------------------------------------------

  readonly view = signal<StageView>('mockup');
  private readonly mockupIdState = signal('');
  private readonly areaIdState = signal('');
  readonly selection = signal<Selection>({ kind: 'product' });
  readonly tool = signal<Tool>({ kind: 'select' });
  readonly sidebarTab = signal<SidebarTab>('mockups');
  /** Opens the "Add printable area" dialog (the sidebar and the empty states both offer it). */
  readonly addAreaDialogOpen = signal(false);
  /** Optional: fill customer slots with bundled sample photos to judge a design. Off by default. */
  readonly sampleContent = signal(false);
  readonly showBoundaries = signal(true);
  /** Artwork shown per area on the stage (the area's default until the merchant picks another). */
  readonly artworkChoice = signal<Readonly<Record<string, string>>>({});

  readonly mockup = computed<ProductMockup | null>(() => {
    const c = this.config();
    return c
      ? (c.mockups.find((m) => m.id === this.mockupIdState()) ?? c.mockups[0] ?? null)
      : null;
  });
  readonly area = computed<PrintableArea | null>(() => {
    const c = this.config();
    return c
      ? (c.printableAreas.find((a) => a.id === this.areaIdState()) ?? c.printableAreas[0] ?? null)
      : null;
  });
  /** The artwork being edited in the artwork view. */
  readonly artwork = computed(() => {
    const c = this.config();
    const area = this.area();
    if (!c || !area) return null;
    const wanted = this.artworkChoice()[area.id];
    const id = area.artworkIds.includes(wanted) ? wanted : area.artworkId;
    return c.artworks.find((a) => a.id === id) ?? null;
  });
  readonly layer = computed<ArtworkLayer | null>(() => {
    const s = this.selection();
    return s.kind === 'layer' ? (this.artwork()?.layers.find((l) => l.id === s.id) ?? null) : null;
  });

  // ---- assets, fonts, sample content -------------------------------------------------------------------

  readonly assetErrors = signal<readonly string[]>([]);
  private readonly fontFamilies = signal<ReadonlyMap<string, string>>(new Map());
  private readonly samples = signal<readonly LocalAsset[]>([]);
  private syncAbort: AbortController | null = null;

  /** Every enabled area, whatever the variant, each showing the artwork chosen on the stage. */
  readonly resolved = computed<ResolvedProduct | null>(() => {
    const c = this.resolvedConfig();
    if (!c) return null;
    const everything = {
      id: '__editor',
      label: 'Editor',
      mockupIds: c.mockups.map((m) => m.id),
      printableAreaIds: c.printableAreas.map((a) => a.id),
    };
    return resolveProduct({ ...c, variants: [everything] }, everything.id, this.artworkChoice());
  });

  private readonly values = computed<DraftValues>(() => {
    const c = this.resolvedConfig();
    if (!c) return {};
    const values = defaultValues(c);
    if (!this.sampleContent()) return values;
    const samples = this.samples();
    let nextPhoto = 0;
    for (const field of c.fields) {
      const value = values[field.id];
      if (field.type === 'image' && samples.length > 0) {
        values[field.id] = { assetId: samples[nextPhoto++ % samples.length].assetId, crop: null };
      } else if (field.type === 'text' && 'text' in value && !value.text) {
        values[field.id] = { ...value, text: field.placeholder ?? field.label };
      }
    }
    return values;
  });

  readonly evaluation = computed<Evaluation | null>(() => {
    const c = this.resolvedConfig();
    const resolved = this.resolved();
    if (!c || !resolved) return null;
    const localAssets = this.assets.localAssets();
    return evaluateProduct(
      {
        config: c,
        fontFamilies: this.fontFamilies(),
        staticImages: this.assets.staticImages(),
        localAssets,
        measurer: this.render.measurer,
        missingGlyphs: () => [],
      },
      resolved,
      this.values(),
      { placeholders: !this.sampleContent() || this.samples().length === 0 },
    );
  });

  constructor() {
    effect(() => {
      const config = this.resolvedConfig();
      if (config) untracked(() => void this.syncAssets(config));
    });
  }

  setSampleContent(on: boolean): void {
    this.sampleContent.set(on);
    if (on && this.samples().length === 0) void this.loadSamples();
  }

  // ---- loading and saving ----------------------------------------------------------------------------

  async open(id: string): Promise<boolean> {
    let record: ConfigurationRecord | null;
    try {
      record = await this.repo.get(id);
    } catch (error) {
      this.toasts.error(
        error instanceof StorageError ? error.message : this.i18n.t('editor.error.open'),
      );
      return false;
    }
    if (!record) return false;
    const draft = record.draft;
    this.record.set(record);
    this.config.set(draft);
    this.saved.set(draft);
    this.saveState.set('idle');
    this.saveError.set(null);
    this.past = [];
    this.future = [];
    this.historyTick.update((n) => n + 1);
    this.mockupIdState.set(draft.mockups[0]?.id ?? '');
    this.areaIdState.set(draft.printableAreas[0]?.id ?? '');
    this.artworkChoice.set({});
    this.selection.set({ kind: 'product' });
    this.view.set('mockup');
    return true;
  }

  /** Store the working draft. Resolves true only after the repository confirmed the write. */
  async saveDraft(): Promise<boolean> {
    const config = this.config();
    const record = this.record();
    if (!config || !record || this.saveState() === 'saving') return false;
    if (this.issues().length > 0) {
      const message = this.i18n.t('editor.error.fix-problems', { count: this.issues().length });
      this.saveState.set('error');
      this.saveError.set(message);
      this.toasts.error(message);
      return false;
    }
    this.saveState.set('saving');
    this.saveError.set(null);
    try {
      const next = await this.repo.saveDraft(record.id, config, record.updatedAt);
      this.record.set(next);
      // The baseline is the object that was stored; edits made while saving stay unsaved.
      this.saved.set(config);
      this.saveState.set('saved');
      return true;
    } catch (error) {
      const message = this.describeFailure(error);
      this.saveState.set('error');
      this.saveError.set(message);
      this.toasts.error(message);
      return false;
    }
  }

  /** Save the draft (if needed), then publish it as the next version. */
  async publish(): Promise<boolean> {
    const record = this.record();
    if (!record || this.publishing()) return false;
    this.publishing.set(true);
    try {
      if (this.dirty() && !(await this.saveDraft())) return false;
      const next = await this.repo.publish(record.id);
      this.record.set(next);
      // The draft carries on as the next version.
      this.config.set(next.draft);
      this.saved.set(next.draft);
      this.past = [];
      this.future = [];
      this.historyTick.update((n) => n + 1);
      this.saveState.set('saved');
      this.toasts.success(this.i18n.t('editor.toast.published'));
      return true;
    } catch (error) {
      this.toasts.error(this.describeFailure(error));
      return false;
    } finally {
      this.publishing.set(false);
    }
  }

  private describeFailure(error: unknown): string {
    if (error instanceof ConfigurationConflictError) {
      return this.i18n.t('editor.error.conflict');
    }
    if (error instanceof ConfigurationInvalidError) {
      return error.issues.length > 0
        ? this.i18n.t('editor.error.not-ready', { message: error.issues[0].message })
        : this.i18n.t('editor.error.incomplete');
    }
    if (error instanceof StorageError) return error.message;
    return this.i18n.t('editor.error.save-generic');
  }

  notify(kind: 'info' | 'error', text: string): void {
    if (kind === 'error') this.toasts.error(text);
    else this.toasts.show('info', text);
  }

  // ---- editing ------------------------------------------------------------------------------------------

  /** Apply an edit. Edits with the same `coalesce` key within a moment become one undo step. */
  edit(mutate: (config: ProductConfig) => ProductConfig, coalesce?: string): void {
    const current = this.config();
    if (!current) return;
    const next = mutate(current);
    if (next === current) return;
    const now = Date.now();
    const merged =
      !!coalesce && coalesce === this.lastEdit.key && now - this.lastEdit.time < COALESCE_MS;
    if (!merged) {
      this.past.push(current);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    this.lastEdit = { key: coalesce ?? '', time: now };
    this.future = [];
    this.config.set(next);
    this.historyTick.update((n) => n + 1);
    this.repairViewState();
  }

  /** Ends a drag / typing burst: the next edit starts a new undo step. */
  breakCoalescing(): void {
    this.lastEdit = { key: '', time: 0 };
  }

  undo(): void {
    const previous = this.past.pop();
    const current = this.config();
    if (!previous || !current) return;
    this.future.push(current);
    this.config.set(previous);
    this.lastEdit = { key: '', time: 0 };
    this.historyTick.update((n) => n + 1);
    this.repairViewState();
  }

  redo(): void {
    const next = this.future.pop();
    const current = this.config();
    if (!next || !current) return;
    this.past.push(current);
    this.config.set(next);
    this.lastEdit = { key: '', time: 0 };
    this.historyTick.update((n) => n + 1);
    this.repairViewState();
  }

  /** After structural edits (delete / undo) make sure the selection still points at something. */
  private repairViewState(): void {
    const c = this.config();
    if (!c) return;
    const s = this.selection();
    const exists =
      s.kind === 'product' ||
      (s.kind === 'variant' && c.variants.some((v) => v.id === s.id)) ||
      (s.kind === 'mockup' && c.mockups.some((m) => m.id === s.id)) ||
      (s.kind === 'area' && c.printableAreas.some((a) => a.id === s.id)) ||
      (s.kind === 'artwork' && c.artworks.some((a) => a.id === s.id)) ||
      (s.kind === 'layer' && c.artworks.some((a) => a.layers.some((l) => l.id === s.id)));
    if (!exists) this.selection.set({ kind: 'product' });
    if (!c.mockups.some((m) => m.id === this.mockupIdState()))
      this.mockupIdState.set(c.mockups[0]?.id ?? '');
    if (!c.printableAreas.some((a) => a.id === this.areaIdState()))
      this.areaIdState.set(c.printableAreas[0]?.id ?? '');
  }

  // ---- selection / navigation ------------------------------------------------------------------------------

  select(selection: Selection): void {
    this.selection.set(selection);
    const c = this.config();
    if (!c) return;
    switch (selection.kind) {
      case 'mockup':
        this.mockupIdState.set(selection.id);
        this.view.set('mockup');
        this.sidebarTab.set('mockups');
        break;
      case 'area':
        this.areaIdState.set(selection.id);
        this.sidebarTab.set('areas');
        break;
      case 'artwork': {
        const artwork = c.artworks.find((a) => a.id === selection.id);
        if (artwork) {
          this.areaIdState.set(artwork.printableAreaId);
          this.artworkChoice.update((m) => ({ ...m, [artwork.printableAreaId]: artwork.id }));
          this.view.set('artwork');
          this.sidebarTab.set('artworks');
        }
        break;
      }
      case 'layer': {
        const found = edit.findLayer(c, selection.id);
        if (found) {
          this.areaIdState.set(found.artwork.printableAreaId);
          this.artworkChoice.update((m) => ({
            ...m,
            [found.artwork.printableAreaId]: found.artwork.id,
          }));
          this.view.set('artwork');
          this.sidebarTab.set('layers');
        }
        break;
      }
    }
  }

  showMockup(id: string): void {
    this.mockupIdState.set(id);
    this.view.set('mockup');
  }

  editArea(areaId: string): void {
    this.areaIdState.set(areaId);
    this.view.set('artwork');
    this.sidebarTab.set('layers');
    this.selection.set({ kind: 'area', id: areaId });
  }

  // ---- compound operations used by the UI ------------------------------------------------------------------------

  async uploadImage(file: File): Promise<string | null> {
    const stored = await this.uploads.store(file);
    if (!stored.ok) {
      this.toasts.error(stored.message);
      return null;
    }
    return stored.src;
  }

  addMockupFromFile(file: File): Promise<void> {
    return this.uploadImage(file).then((src) => {
      if (!src) return;
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Mockup';
      let created = '';
      this.edit((c) => {
        const r = edit.addMockup(c, { name, src });
        created = r.id;
        return r.config;
      });
      if (created) this.select({ kind: 'mockup', id: created });
    });
  }

  addAreaOnMockup(
    shape: ShapeSpec,
    box: { x: number; y: number; width: number; height: number },
    mockupSize: { w: number; h: number },
  ): void {
    const mockup = this.mockup();
    if (!mockup) return;
    const aspect = (box.width * mockupSize.w) / (box.height * mockupSize.h);
    const long = 2000;
    const canvasWidth = aspect >= 1 ? long : Math.max(200, Math.round(long * aspect));
    const canvasHeight = aspect >= 1 ? Math.max(200, Math.round(long / aspect)) : long;
    let created = '';
    this.edit((c) => {
      const name = `Print area ${c.printableAreas.length + 1}`;
      const r = edit.addArea(c, {
        name,
        shape,
        canvasWidth,
        canvasHeight,
        mockupId: mockup.id,
        placement: { type: 'rect', ...box },
      });
      created = r.areaId;
      return r.config;
    });
    // Stay on the product photo so the new placement can be adjusted in context.
    if (created) this.select({ kind: 'area', id: created });
  }

  addAreaDefault(shape: ShapeSpec): void {
    const mockup = this.mockup();
    const size = mockup ? this.mockupSize(mockup.id) : null;
    if (!mockup || !size) return;
    const w = 0.3;
    const h = 0.3 * (size.w / size.h);
    this.addAreaOnMockup(
      shape,
      { x: 0.35, y: Math.max(0.05, 0.5 - h / 2), width: w, height: Math.min(h, 0.8) },
      size,
    );
  }

  /** Natural size of a mockup's image, once decoded. */
  mockupSize(mockupId: string): { w: number; h: number } | null {
    const resolved = this.resolvedConfig()?.mockups.find((m) => m.id === mockupId);
    const bitmap = resolved ? this.assets.staticImages().get(resolved.src) : undefined;
    return bitmap ? { w: bitmap.width, h: bitmap.height } : null;
  }

  placementFor(areaId: string): AreaPlacement | null {
    return this.mockup()?.placements.find((p) => p.printableAreaId === areaId) ?? null;
  }

  // ---- exports ----------------------------------------------------------------------------------------------------

  composite(mockupId: string): PreviewComposite | null {
    const c = this.resolvedConfig();
    const evaluation = this.evaluation();
    const mockup = c?.mockups.find((m) => m.id === mockupId);
    const bitmap = mockup ? this.assets.staticImages().get(mockup.src) : undefined;
    if (!c || !evaluation || !mockup || !bitmap) return null;
    const scenes = new Map(evaluation.areas.map((s) => [s.areaId, s]));
    const images = this.assets.staticImages();
    return {
      mockup,
      bitmap,
      background: c.preview?.background,
      areas: mockup.placements
        .filter((p) => scenes.has(p.printableAreaId))
        .map((placement) => ({ placement, scene: scenes.get(placement.printableAreaId)! })),
      overlays: (mockup.overlays ?? [])
        .map((overlay) => ({ overlay, bitmap: images.get(overlay.src) }))
        .filter((e): e is { overlay: typeof e.overlay; bitmap: ImageBitmap } => !!e.bitmap),
    };
  }

  async exportConfigJson(): Promise<void> {
    const config = this.config();
    if (!config) return;
    const json = await this.transfer.exportJson(config);
    downloadBlob(new Blob([json], { type: 'application/json' }), `${safeFilename(config.id)}.json`);
  }

  async exportAreaPng(areaId: string): Promise<void> {
    const scene = this.evaluation()?.areas.find((s) => s.areaId === areaId);
    if (!scene) {
      this.notify('error', this.i18n.t('editor.error.export-area'));
      return;
    }
    downloadBlob(await this.exporter.areaPng(scene), `${safeFilename(scene.areaId)}-artwork.png`);
  }

  async exportAllAreaPngs(): Promise<void> {
    for (const scene of this.evaluation()?.areas ?? []) {
      downloadBlob(await this.exporter.areaPng(scene), `${safeFilename(scene.areaId)}-artwork.png`);
    }
  }

  async exportPreviewPng(mockupId: string): Promise<void> {
    const composite = this.composite(mockupId);
    if (!composite) {
      this.notify('error', this.i18n.t('editor.error.export-preview'));
      return;
    }
    downloadBlob(
      await this.exporter.previewPng(composite),
      `${safeFilename(mockupId)}-preview.png`,
    );
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private async syncAssets(config: ProductConfig): Promise<void> {
    this.syncAbort?.abort();
    const controller = new AbortController();
    this.syncAbort = controller;
    try {
      const failed = await this.assets.syncStatic(config, controller.signal);
      this.assetErrors.set(failed);
      const entries = await Promise.all(
        config.fonts.map(
          async (font) => [font.id, await this.fonts.load(font).catch(() => null)] as const,
        ),
      );
      if (controller.signal.aborted) return;
      this.fontFamilies.set(
        new Map(entries.filter((e): e is readonly [string, string] => e[1] !== null)),
      );
    } catch {
      // Superseded by a newer configuration; nothing to report.
    }
  }

  private async loadSamples(): Promise<void> {
    const loaded: LocalAsset[] = [];
    for (const name of SAMPLE_PHOTOS) {
      try {
        const blob = await this.images.fetchBlob(
          new URL(`assets/samples/${name}.jpg`, assetBaseUrl()).href,
        );
        const bitmap = await this.images.decodeBlob(blob);
        const asset: LocalAsset = {
          assetId: `sample-${name}`,
          blob,
          mimeType: 'image/jpeg',
          width: bitmap.width,
          height: bitmap.height,
          bitmap,
        };
        this.assets.addLocal(asset);
        loaded.push(asset);
      } catch {
        // Sample photos are a convenience; the editor works with placeholders without them.
      }
    }
    this.samples.set(loaded);
  }

  dispose(): void {
    this.syncAbort?.abort();
    this.assets.dispose();
  }
}
