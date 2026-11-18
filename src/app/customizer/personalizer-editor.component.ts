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
import { CustomizerError, PrepareError } from './services/errors';
import { ExportService, SavePayload } from './services/export.service';
import { LoadOutcome, LoadPipeline, LoadRequest } from './services/load-pipeline.service';
import { SaveCoordinator } from './services/save-coordinator.service';
import { StateService } from './services/state.service';
import { coerceBoolean } from './util/coerce';
import { stableKey } from './util/draft-utils';
import { formatMinor } from './util/price';
import { ActiveField } from './util/resolve';

/** Debounce for `customizer-change` while the shopper is typing. */
export const CHANGE_DEBOUNCE_MS = 150;

/** What the editor tells its shell when the shopper asks to save: the frozen payload and what it was built from. */
export interface EditorSaveRequest {
  detail: CustomizerSaveDetail;
  /** Key of the draft the payload froze; the saved baseline once the acknowledgement succeeds. */
  valuesKey: string;
  templateId: string;
  templateVersion: number;
}

/** The current design exported for persistence (`prepareForCart`). */
export interface ExportedDesign {
  payload: SavePayload;
  valuesKey: string;
  templateId: string;
  templateVersion: number;
}

export interface EditorGate {
  allowed: boolean;
  reason?: string;
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
 * The personalization editor: the live preview, the generated inputs, validation, export and the save
 * protocol (`editorSave` -> the shell -> `saveResult`). It is created lazily by `<zb-product-customizer>`
 * (inline in `preview` mode, inside the modal in `storefront` mode), is given an already-resolved
 * configuration and knows nothing about products, the personalization API, the host's cart or the
 * `zb:event` channel; the shell owns all of that.
 *
 * It has no styles of its own: it renders into the shell's shadow root, which carries the one stylesheet
 * (`product-customizer.component.scss`), so nothing is added to the host page's CSS.
 *
 * All mutable state lives in services provided on this component, so every instance is independent and is
 * released when it is destroyed.
 */
@Component({
  selector: 'app-personalizer-editor',
  imports: [
    PreviewComponent,
    ViewPickerComponent,
    ChoiceGroupComponent,
    TextFieldComponent,
    PhotoFieldComponent,
    ArtworkFieldComponent,
    ActionBarComponent,
  ],
  providers: [AssetStore, StateService, SaveCoordinator, LoadPipeline],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './personalizer-editor.component.html',
})
export class PersonalizerEditorComponent {
  // ---- inputs (set by the shell) ---------------------------------------------------------------
  readonly config = input<unknown>(null);
  readonly configUrl = input<string | null>(null);
  readonly baseUrl = input<string | null>(null);
  readonly initialCustomization = input<unknown>(null);
  readonly assetMap = input<LoadRequest['assetMap']>(null);
  readonly allowedAssetOrigins = input<readonly string[] | null>(null);
  readonly allowLocalAssets = input<boolean, unknown>(false, { transform: coerceBoolean });
  readonly disabled = input<boolean, unknown>(false, { transform: coerceBoolean });
  /** The acknowledgement of the last `editorSave`, from the host (or from the shell when it persists). */
  readonly saveResult = input<unknown>(null);
  /** Hides this editor's own Save button (the host's Add to cart is the primary action). */
  readonly hideSave = input<boolean, unknown>(false, { transform: coerceBoolean });

  // ---- outputs ------------------------------------------------------------------------------------
  readonly editorReady = output<CustomizerReadyDetail>();
  readonly editorChange = output<CustomizerChangeDetail>();
  readonly editorSave = output<EditorSaveRequest>();
  readonly editorError = output<CustomizerErrorDetail>();

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
  /** What the pending save request was built from, kept so a retry after a timeout reports the same. */
  private pendingSave: { valuesKey: string; templateId: string; templateVersion: number } | null = null;

  // ---- state the shell reads ---------------------------------------------------------------------------
  readonly status = this.state.status;
  readonly saveState = this.save.state;
  readonly dirty = this.state.dirty;

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
    if (this.disabled() || this.state.status() !== 'ready') return true;
    if (state === 'no-response') return false; // retry
    return !this.save.canStart() || !this.state.valid() || this.state.busy().size > 0;
  });

  protected readonly resetDisabled = computed(
    () => this.disabled() || this.save.locked() || !this.state.differsFromDefaults(),
  );

  protected readonly editingLocked = this.state.locked;

  /** Whether the design can be saved or added to the cart right now, and why not. */
  readonly gate = computed<EditorGate>(() => {
    if (this.state.status() !== 'ready') return { allowed: false, reason: 'Personalization is still loading.' };
    if (this.disabled()) return { allowed: false, reason: 'Personalization is unavailable right now.' };
    if (!this.state.valid() || this.state.busy().size > 0) {
      return { allowed: false, reason: this.blockers()[0] ?? 'Please complete the personalization.' };
    }
    return { allowed: true };
  });

  constructor() {
    this.state.bindHostDisabled(this.disabled);

    // (Re)load whenever the shell assigns a new configuration or restore data.
    effect(() => {
      const request: LoadRequest = {
        config: this.config(),
        configUrl: this.configUrl(),
        baseUrl: this.baseUrl(),
        allowedOrigins: this.allowedAssetOrigins(),
        allowLocalAssets: this.allowLocalAssets(),
        initialCustomization: this.initialCustomization(),
        assetMap: this.assetMap(),
      };
      untracked(() => void this.startLoad(request));
    });

    // Acknowledgements.
    effect(() => {
      const result = this.saveResult();
      if (result !== null && result !== undefined) untracked(() => this.applySaveResult(result));
    });

    // An edit after a result clears the old status line.
    effect(() => {
      this.state.editCount();
      untracked(() => this.save.noteEdit());
    });

    // change events
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
    const config = this.state.config();
    const evaluation = this.state.evaluation();
    const customization = this.state.customization();
    const composites = this.state.composites();
    if (this.saveDisabled() || !config || !evaluation || !customization || composites.length === 0) return;

    const valuesKey = this.state.currentKey();
    const localAssets = this.state.assets.localAssets();
    this.pendingSave = { valuesKey, templateId: config.id, templateVersion: config.version };
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
        () => !this.disabled() && this.state.status() === 'ready',
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

  // ---- host commands -------------------------------------------------------------------------

  /** Key of the current draft: lets the shell tell whether the design changed while it was being saved. */
  currentKey(): string {
    return this.state.currentKey();
  }

  /**
   * Exports the current design (the same files a Save click produces) without touching the save protocol.
   * The shell checks `gate()` first; this only refuses what cannot be exported at all.
   */
  async exportCurrent(): Promise<ExportedDesign> {
    const config = this.state.config();
    const evaluation = this.state.evaluation();
    const customization = this.state.customization();
    const composites = this.state.composites();
    if (!config || !evaluation || !customization || composites.length === 0) {
      throw new PrepareError('Personalization is still loading. Please wait a moment.');
    }
    const valuesKey = this.state.currentKey();
    const payload = await this.exporter.export({
      scenes: evaluation.areas,
      composites,
      customization,
      localAssets: this.state.assets.localAssets(),
    });
    return { payload, valuesKey, templateId: config.id, templateVersion: config.version };
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
          templateId: outcome.config.id,
          templateVersion: outcome.config.version,
          // The original version-1 event detail is kept exactly as hosts know it.
          ...(outcome.sourceVersion === 2 ? { schemaVersion: 2 as const } : {}),
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
      if (!this.destroyed) this.editorChange.emit(structuredClone(snapshot));
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
    if (!this.destroyed) this.editorReady.emit(detail);
  }

  private emitSave(detail: CustomizerSaveDetail): void {
    const pending = this.pendingSave;
    if (this.destroyed || !pending) return;
    this.editorSave.emit({ detail, ...pending });
  }

  private emitError(detail: CustomizerErrorDetail): void {
    if (!this.destroyed) this.editorError.emit(detail);
  }

  private teardown(): void {
    this.destroyed = true;
    this.abort?.abort();
    this.cancelPendingChange();
    this.save.cancel();
    this.state.dispose();
  }
}
