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
import { PhotoFieldComponent } from './components/photo-field.component';
import { PreviewComponent } from './components/preview.component';
import { TextFieldComponent } from './components/text-field.component';
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
import { stableKey } from './util/draft-utils';
import { formatMinor } from './util/price';

/** Debounce for `customizer-change` while the shopper is typing. */
export const CHANGE_DEBOUNCE_MS = 150;

/** absent/false -> false; empty string / true / any other string except "false" -> true. */
export function coerceDisabled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return value === true;
}

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
    TextFieldComponent,
    PhotoFieldComponent,
    ArtworkFieldComponent,
    ActionBarComponent,
  ],
  providers: [AssetStore, StateService, SaveCoordinator, LoadPipeline],
  encapsulation: ViewEncapsulation.ShadowDom,
  templateUrl: './product-customizer.component.html',
  styleUrl: './product-customizer.component.scss',
  host: {
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
  readonly disabled = input<boolean, unknown>(false, { transform: coerceDisabled });
  readonly saveResult = input<unknown>(null);

  // ---- public outputs (aliases are the DOM event names) ----------------------------------
  readonly customizerReady = output<CustomizerReadyDetail>({ alias: 'customizer-ready' });
  readonly customizerChange = output<CustomizerChangeDetail>({ alias: 'customizer-change' });
  readonly customizerSave = output<CustomizerSaveDetail>({ alias: 'customizer-save' });
  readonly customizerError = output<CustomizerErrorDetail>({ alias: 'customizer-error' });

  protected readonly state = inject(StateService);
  protected readonly save = inject(SaveCoordinator);
  private readonly pipeline = inject(LoadPipeline);
  private readonly exporter = inject(ExportService);

  protected readonly failure = signal<{ message: string; issues: readonly ConfigIssue[] } | null>(
    null,
  );
  protected readonly restoreNotices = signal<readonly string[]>([]);

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
    const texts = config.fields
      .map((field) => {
        const value = this.state.values()[field.id];
        return field.type === 'text' && value && 'text' in value && value.text.trim()
          ? `${field.label}: ${value.text}`
          : null;
      })
      .filter(Boolean);
    return `Live preview of ${config.product.name}${texts.length ? `. ${texts.join('. ')}` : ''}`;
  });

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

  constructor() {
    this.state.bindHostDisabled(this.disabled);

    // (Re)load whenever the host assigns a new configuration or restore data.
    effect(() => {
      const request: LoadRequest = {
        config: this.config(),
        configUrl: this.configUrl(),
        baseUrl: this.baseUrl(),
        allowedOrigins: this.allowedAssetOrigins(),
        initialCustomization: this.initialCustomization(),
        assetMap: this.assetMap(),
      };
      untracked(() => void this.startLoad(request));
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
    const config = this.state.config();
    const evaluation = this.state.evaluation();
    const customization = this.state.customization();
    const mockup = this.state.mockup();
    if (this.saveDisabled() || !config || !evaluation || !customization || !mockup) return;

    const valuesKey = stableKey(this.state.values());
    const localAssets = this.state.assets.localAssets();
    try {
      await this.save.start(
        () =>
          this.exporter.export({
            config,
            scene: evaluation.scene,
            mockup,
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

  private async startLoad(request: LoadRequest): Promise<void> {
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
          templateId: outcome.config.templateId,
          templateVersion: outcome.config.templateVersion,
        });
        break;
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
    this.cancelPendingChange();
    this.save.cancel();
    this.state.dispose();
  }
}
