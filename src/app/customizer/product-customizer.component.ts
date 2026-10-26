import {
  Component,
  DestroyRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ActionBarComponent, PriceView } from './components/action-bar.component';
import { ArtworkFieldComponent } from './components/artwork-field.component';
import { Choice, ChoiceGroupComponent } from './components/choice-group.component';
import { PhotoFieldComponent } from './components/photo-field.component';
import { PreviewComponent } from './components/preview.component';
import { TextFieldComponent, TextStyleDefaults } from './components/text-field.component';
import { ViewPickerComponent } from './components/view-picker.component';
import { ArtworkFieldSpec, ConfigIssue, FieldSpec, TextFieldSpec } from './models/config.models';
import { ArtworkValue, FieldError, TextValue } from './models/draft.models';
import {
  CustomizerChangeDetail,
  CustomizerErrorDetail,
  CustomizerReadyDetail,
  CustomizerSaveDetail,
  SaveResult,
} from './models/events.models';
import { AssetStore } from './services/asset-store.service';
import { CustomizerError } from './services/errors';
import { ExportService } from './services/export.service';
import { LoadOutcome, LoadPipeline, LoadRequest } from './services/load-pipeline.service';
import { SaveCoordinator } from './services/save-coordinator.service';
import { StateService } from './services/state.service';
import { ResolveOutcome, StorefrontResolver } from './services/storefront-resolver.service';
import { stableKey } from './util/draft-utils';
import { coerceBoolean, coerceStringList } from './util/coerce';
import { formatMinor } from './util/price';
import { ActiveField } from './util/resolve';

/** Debounce for `customizer-change` while the shopper is typing. */
export const CHANGE_DEBOUNCE_MS = 150;

/** Kept for existing importers; see `util/coerce.ts`. */
export { coerceBoolean as coerceDisabled };

function coerceTheme(value: unknown): 'light' | 'dark' | 'auto' {
  return value === 'dark' || value === 'auto' ? value : 'light';
}

type Resolution =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'mapped'; key: string; config: unknown }
  | { kind: 'unmapped' }
  | { kind: 'failed' };

function isSaveResult(value: unknown): value is SaveResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['requestId'] === 'string' &&
    (v['status'] === 'success' || v['status'] === 'error') &&
    (v['message'] === undefined || typeof v['message'] === 'string')
  );
}

/**
 * The customizer. Inputs and outputs here are the public custom-element contract
 * (see `models/element-contract.ts`); Angular Elements turns them into properties, attributes
 * and `customizer-*` DOM events. All mutable state lives in services provided on this
 * component, so every element instance is fully independent.
 *
 * Every style lives in this component's shadow root (one stylesheet, no child styles), so
 * nothing is added to the host page's CSS and host CSS can't reach the internals.
 */
@Component({
  selector: 'app-product-customizer',
  imports: [
    PreviewComponent,
    ViewPickerComponent,
    ChoiceGroupComponent,
    TextFieldComponent,
    PhotoFieldComponent,
    ArtworkFieldComponent,
    ActionBarComponent,
  ],
  providers: [AssetStore, StateService, SaveCoordinator, LoadPipeline, StorefrontResolver],
  encapsulation: ViewEncapsulation.ShadowDom,
  templateUrl: './product-customizer.component.html',
  styleUrl: './product-customizer.component.scss',
  host: {
    '[attr.theme]': 'theme()',
    '[attr.data-status]': 'state.status()',
    '[attr.data-save-state]': 'save.state()',
  },
})
export class ProductCustomizerComponent {
  // ---- public inputs (property names are the element's property names) -------------------
  readonly config = input<unknown>(null);
  readonly configUrl = input<string | null>(null);
  readonly baseUrl = input<string | null>(null);
  readonly initialCustomization = input<unknown>(null);
  readonly assetMap = input<LoadRequest['assetMap']>(null);
  readonly allowedAssetOrigins = input<readonly string[] | null>(null);
  /** Standalone authoring app only: accept `idb:` and inline `data:image/` asset sources. */
  readonly allowLocalAssets = input<boolean, unknown>(false, { transform: coerceBoolean });
  readonly disabled = input<boolean, unknown>(false, { transform: coerceBoolean });
  readonly saveResult = input<unknown>(null);
  /** Appearance: `light` (default), `dark`, or `auto` (follows the visitor's colour scheme). */
  readonly theme = input<'light' | 'dark' | 'auto', unknown>('light', { transform: coerceTheme });

  // ---- resolve-by-product (used only when neither `config` nor `configUrl` is set) -------------
  /** The host's id of the product on this page. */
  readonly productId = input<string | null>(null);
  readonly variantId = input<string | null>(null);
  /** Ids of the collections the product belongs to (array property or comma separated attribute). */
  readonly collectionIds = input<readonly string[], unknown>([], { transform: coerceStringList });
  readonly apiBaseUrl = input<string | null>(null);
  /** Public storefront key of the store; not a secret. */
  readonly storeId = input<string | null>(null);

  // ---- public outputs (aliases are the DOM event names) ----------------------------------
  readonly customizerReady = output<CustomizerReadyDetail>({ alias: 'customizer-ready' });
  readonly customizerChange = output<CustomizerChangeDetail>({ alias: 'customizer-change' });
  readonly customizerSave = output<CustomizerSaveDetail>({ alias: 'customizer-save' });
  readonly customizerError = output<CustomizerErrorDetail>({ alias: 'customizer-error' });

  protected readonly state = inject(StateService);
  protected readonly save = inject(SaveCoordinator);
  private readonly pipeline = inject(LoadPipeline);
  private readonly exporter = inject(ExportService);
  private readonly resolver = inject(StorefrontResolver);

  protected readonly failure = signal<{ message: string; issues: readonly ConfigIssue[] } | null>(
    null,
  );
  protected readonly restoreNotices = signal<readonly string[]>([]);

  private readonly resolution = signal<Resolution>({ kind: 'idle' });
  private readonly retryTick = signal(0);
  private resolveAbort: AbortController | null = null;
  private abort: AbortController | null = null;
  private destroyed = false;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChangeKey = '';

  // ---- derived view state ----------------------------------------------------------------
  protected readonly hostDisabled = this.disabled;

  protected readonly fieldErrors = computed<Readonly<Record<string, readonly FieldError[]>>>(() => {
    const touched = this.state.touched();
    const grouped: Record<string, FieldError[]> = {};
    for (const error of this.state.errors()) {
      // "Required" is shown after the shopper has visited the field; every other problem immediately.
      if (error.code === 'required' && !touched.has(error.fieldId)) continue;
      (grouped[error.fieldId] ??= []).push(error);
    }
    return grouped;
  });

  protected readonly blockers = computed<string[]>(() => {
    const config = this.state.config();
    if (!config) return [];
    const labels = new Map(config.fields.map((f) => [f.id, f.label]));
    const lines = this.state
      .errors()
      .map((e) =>
        e.code === 'required' ? e.message : `${labels.get(e.fieldId) ?? e.fieldId}: ${e.message}`,
      );
    if (this.state.busy().size > 0) lines.push('A photo is still being processed.');
    return lines.length > 5 ? [...lines.slice(0, 5), `…and ${lines.length - 5} more`] : lines;
  });

  protected readonly price = computed<PriceView | null>(() => {
    const spec = this.state.config()?.displayPrice;
    if (!spec) return null;
    const { currency, exponent } = spec;
    return {
      total: formatMinor(spec.baseMinor + spec.customizationFeeMinor, currency, exponent),
      base: formatMinor(spec.baseMinor, currency, exponent),
      fee: formatMinor(spec.customizationFeeMinor, currency, exponent),
    };
  });

  protected readonly previewLabel = computed(() => {
    const config = this.state.config();
    if (!config) return '';
    const texts = this.state
      .activeFields()
      .map(({ field }) => {
        const value = this.state.values()[field.id];
        return field.type === 'text' && value && 'text' in value && value.text.trim()
          ? `${field.label}: ${value.text}`
          : null;
      })
      .filter(Boolean);
    return `Live preview of ${config.product.name}${texts.length ? `. ${texts.join('. ')}` : ''}`;
  });

  protected readonly variantChoices = computed<Choice[]>(() =>
    (this.state.config()?.variants ?? []).map((v) => ({
      id: v.id,
      label: v.label,
      swatch: v.swatch,
    })),
  );

  protected readonly saveDisabled = computed(() => {
    const state = this.save.state();
    if (this.hostDisabled() || this.state.status() !== 'ready') return true;
    if (state === 'no-response') return false; // retry
    return !this.save.canStart() || !this.state.valid() || this.state.busy().size > 0;
  });

  protected readonly resetDisabled = computed(
    () => this.hostDisabled() || this.save.locked() || !this.state.differsFromDefaults(),
  );

  protected readonly editingLocked = this.state.locked;

  /** A transient failure while asking the API which template is mapped can be retried. */
  protected readonly canRetry = computed(() => this.resolution().kind === 'failed');

  /** True when the host asks for resolution by product rather than supplying a configuration. */
  private readonly productMode = computed(
    () =>
      !this.hasValue(this.config()) &&
      !this.hasValue(this.configUrl()) &&
      !!this.productId() &&
      !!this.apiBaseUrl() &&
      !!this.storeId(),
  );

  constructor() {
    this.state.bindHostDisabled(this.disabled);

    // Ask the API which published template is mapped to this product/variant/collections.
    effect(() => {
      const request = this.productMode()
        ? {
            apiBaseUrl: this.apiBaseUrl()!,
            storeId: this.storeId()!,
            productId: this.productId()!,
            variantId: this.variantId(),
            collectionIds: this.collectionIds(),
          }
        : null;
      this.retryTick();
      untracked(() => void this.startResolve(request));
    });

    // (Re)load whenever the host assigns a new configuration, restore data or the mapped template changes.
    effect(() => {
      const resolution = this.resolution();
      const productMode = this.productMode();
      const apiOrigin = productMode ? this.originOf(this.apiBaseUrl()) : null;
      const hostOrigins = this.allowedAssetOrigins();
      const request: LoadRequest = {
        config: productMode
          ? resolution.kind === 'mapped'
            ? resolution.config
            : null
          : this.config(),
        configUrl: productMode ? null : this.configUrl(),
        baseUrl: this.baseUrl(),
        // An empty list already means "any http(s) origin"; only extend a restrictive list.
        allowedOrigins:
          productMode && apiOrigin && hostOrigins && hostOrigins.length > 0
            ? [...hostOrigins, apiOrigin]
            : hostOrigins,
        allowLocalAssets: this.allowLocalAssets(),
        initialCustomization: this.initialCustomization(),
        assetMap: this.assetMap(),
      };
      untracked(() => {
        if (productMode && resolution.kind !== 'mapped') {
          this.holdForResolution(resolution);
          return;
        }
        void this.startLoad(request, productMode);
      });
    });

    // Host acknowledgements.
    effect(() => {
      const result = this.saveResult();
      if (result !== null && result !== undefined) untracked(() => this.applySaveResult(result));
    });

    // An edit after a result clears the old status line.
    effect(() => {
      this.state.editCount();
      untracked(() => this.save.noteEdit());
    });

    // customizer-change
    effect(() => {
      if (this.state.status() !== 'ready') return;
      const draft = this.state.customization();
      if (!draft) return;
      const snapshot: CustomizerChangeDetail = {
        draft,
        valid: this.state.valid(),
        dirty: this.state.dirty(),
        errors: this.state.errors().map((e) => ({ ...e })),
      };
      untracked(() => this.scheduleChange(snapshot));
    });

    inject(DestroyRef).onDestroy(() => this.teardown());
  }

  // ---- template helpers -------------------------------------------------------------------

  protected textValue(field: FieldSpec): TextValue {
    return this.state.values()[field.id] as TextValue;
  }

  protected artworkValue(field: FieldSpec): ArtworkValue {
    return this.state.values()[field.id] as ArtworkValue;
  }

  protected optionChoices(options: readonly { id: string; name: string }[]): Choice[] {
    return options.map((o) => ({ id: o.id, label: o.name }));
  }

  /** The style of the first text layer a field feeds: what the customer sees before choosing. */
  protected layerStyle(entry: ActiveField): TextStyleDefaults {
    const layer = entry.bindings.map((b) => b.layer).find((l) => l.type === 'text');
    return {
      bold: layer?.type === 'text' ? (layer.bold ?? false) : false,
      italic: layer?.type === 'text' ? (layer.italic ?? false) : false,
      underline: layer?.type === 'text' ? (layer.underline ?? false) : false,
      align: layer?.type === 'text' ? layer.align : 'center',
    };
  }

  protected asText(field: FieldSpec): TextFieldSpec {
    return field as TextFieldSpec;
  }

  protected asArtwork(field: FieldSpec): ArtworkFieldSpec {
    return field as ArtworkFieldSpec;
  }

  protected errorsFor(fieldId: string): readonly FieldError[] {
    return this.fieldErrors()[fieldId] ?? [];
  }

  protected warningsFor(fieldId: string): readonly string[] {
    return this.state.evaluation()?.warnings[fieldId] ?? [];
  }

  protected isBusy(fieldId: string): boolean {
    return this.state.busy().has(fieldId);
  }

  protected uploadErrorFor(fieldId: string): string | null {
    return this.state.uploadErrors()[fieldId] ?? null;
  }

  // ---- actions -----------------------------------------------------------------------------

  protected async onSave(): Promise<void> {
    if (this.save.state() === 'no-response') {
      if (!this.saveDisabled()) this.save.retry((detail) => this.emitSave(detail));
      return;
    }
    const evaluation = this.state.evaluation();
    const customization = this.state.customization();
    const composites = this.state.composites();
    if (this.saveDisabled() || !evaluation || !customization || composites.length === 0) return;

    const valuesKey = this.state.currentKey();
    const localAssets = this.state.assets.localAssets();
    try {
      await this.save.start(
        () =>
          this.exporter.export({
            scenes: evaluation.areas,
            composites,
            customization,
            localAssets,
          }),
        (detail) => this.emitSave(detail),
        valuesKey,
        () => !this.hostDisabled() && this.state.status() === 'ready',
      );
    } catch (error) {
      const known = error instanceof CustomizerError;
      this.emitError({
        code: known ? error.code : 'export-failed',
        message: known ? error.message : 'The design could not be exported.',
        recoverable: true,
      });
    }
  }

  protected onReset(): void {
    this.state.resetAll();
  }

  // ---- load lifecycle -------------------------------------------------------------------

  private async startLoad(request: LoadRequest, resolvedByProduct = false): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.save.cancel();
    this.cancelPendingChange();
    this.lastChangeKey = '';
    this.failure.set(null);
    this.restoreNotices.set([]);

    const nothingSupplied =
      (request.config === null || request.config === undefined) &&
      (request.configUrl === null || request.configUrl === undefined || request.configUrl === '');
    if (nothingSupplied) {
      this.state.setStatus('awaiting-config');
      return;
    }

    this.state.beginLoad();
    let outcome: LoadOutcome;
    try {
      outcome = await this.pipeline.run(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return; // superseded: ignore whatever it was doing
      this.failLoad('asset-error', {
        code: 'unexpected',
        message:
          error instanceof CustomizerError ? error.message : 'The customizer could not start.',
        recoverable: false,
      });
      return;
    }

    if (controller.signal.aborted || this.destroyed) {
      // A newer load (or teardown) won the race: release what this one produced.
      if (outcome.kind === 'ready') {
        outcome.staticImages.forEach((bitmap) => bitmap.close());
        outcome.localAssets.forEach((asset) => asset.bitmap.close());
      }
      return;
    }

    switch (outcome.kind) {
      case 'awaiting':
        this.state.setStatus('awaiting-config');
        break;
      case 'failed':
        this.failLoad(outcome.status, outcome.error, outcome.issues);
        break;
      case 'ready':
        this.state.commit(outcome);
        this.restoreNotices.set(outcome.notices.map((notice) => notice.message));
        for (const notice of outcome.notices) this.emitError(notice);
        this.emitReady({
          productId: outcome.config.product.id,
          templateId: outcome.config.id,
          templateVersion: outcome.config.version,
          // The original version-1 event detail is kept exactly as hosts know it.
          ...(outcome.sourceVersion === 2 ? { schemaVersion: 2 as const } : {}),
          ...(resolvedByProduct ? { personalizable: true } : {}),
        });
        break;
    }
  }

  // ---- resolve by product -----------------------------------------------------------------

  private hasValue(value: unknown): boolean {
    return value !== null && value !== undefined && value !== '';
  }

  private originOf(url: string | null): string | null {
    try {
      return url ? new URL(url).origin : null;
    } catch {
      return null;
    }
  }

  protected retryResolve(): void {
    this.retryTick.update((n) => n + 1);
  }

  private async startResolve(
    request: Parameters<StorefrontResolver['resolve']>[0] | null,
  ): Promise<void> {
    this.resolveAbort?.abort();
    if (!request) {
      if (this.resolution().kind !== 'idle') this.resolution.set({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    this.resolveAbort = controller;
    const previous = this.resolution();
    // Keep showing the current design while a variant/collection change is re-checked.
    if (previous.kind !== 'mapped') this.resolution.set({ kind: 'resolving' });
    let outcome: ResolveOutcome;
    try {
      outcome = await this.resolver.resolve(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || this.destroyed) return;
      const known = error instanceof CustomizerError;
      this.resolution.set({ kind: 'failed' });
      this.failLoad('invalid-config', {
        code: known ? error.code : 'config-load-failed',
        message: known ? error.message : 'The personalization service could not be reached.',
        recoverable: known ? error.recoverable : true,
      });
      return;
    }
    if (controller.signal.aborted || this.destroyed) return;
    if (outcome.kind === 'unmapped') {
      this.resolution.set({ kind: 'unmapped' });
      return;
    }
    const key = `${outcome.configId}@${outcome.version}`;
    // Same template and version as before: keep the loaded design (and the shopper's input).
    if (previous.kind === 'mapped' && previous.key === key) return;
    this.resolution.set({ kind: 'mapped', key, config: outcome.config });
  }

  /** Product mode without a template (yet): show loading, the fallback, or leave the failure panel. */
  private holdForResolution(resolution: Resolution): void {
    this.abort?.abort();
    this.save.cancel();
    this.cancelPendingChange();
    this.lastChangeKey = '';
    this.restoreNotices.set([]);
    switch (resolution.kind) {
      case 'resolving':
        this.failure.set(null);
        this.state.beginLoad();
        break;
      case 'unmapped':
        this.failure.set(null);
        this.state.setStatus('not-personalizable');
        this.emitReady({
          productId: this.productId() ?? '',
          templateId: '',
          templateVersion: 0,
          personalizable: false,
        });
        break;
      case 'failed': // the failure panel was already set by startResolve
        break;
      default:
        this.state.setStatus('awaiting-config');
    }
  }

  private failLoad(
    status: 'invalid-config' | 'asset-error',
    error: CustomizerErrorDetail,
    issues: readonly ConfigIssue[] = [],
  ): void {
    this.state.setStatus(status);
    this.failure.set({ message: error.message, issues });
    this.emitError(error);
  }

  private applySaveResult(result: unknown): void {
    if (!isSaveResult(result)) return;
    const outcome = this.save.acknowledge(result);
    if (outcome.applied && outcome.savedKey !== undefined) this.state.markSaved(outcome.savedKey);
  }

  // ---- events --------------------------------------------------------------------------------

  private scheduleChange(snapshot: CustomizerChangeDetail): void {
    const key = stableKey(snapshot);
    if (key === this.lastChangeKey) {
      this.cancelPendingChange();
      return;
    }
    this.cancelPendingChange();
    const emit = () => {
      this.changeTimer = null;
      this.lastChangeKey = key;
      if (!this.destroyed) this.customizerChange.emit(structuredClone(snapshot));
    };
    if (this.state.lastEditKind === 'text') {
      this.changeTimer = setTimeout(emit, CHANGE_DEBOUNCE_MS);
    } else {
      emit();
    }
  }

  private cancelPendingChange(): void {
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = null;
  }

  private emitReady(detail: CustomizerReadyDetail): void {
    if (!this.destroyed) this.customizerReady.emit(detail);
  }

  private emitSave(detail: CustomizerSaveDetail): void {
    if (!this.destroyed) this.customizerSave.emit(detail);
  }

  private emitError(detail: CustomizerErrorDetail): void {
    if (!this.destroyed) this.customizerError.emit(detail);
  }

  private teardown(): void {
    this.destroyed = true;
    this.abort?.abort();
    this.resolveAbort?.abort();
    this.cancelPendingChange();
    this.save.cancel();
    this.state.dispose();
  }
}
