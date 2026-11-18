import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ComponentRef,
  DestroyRef,
  ElementRef,
  Injector,
  ViewContainerRef,
  afterNextRender,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ZbRenderMode, ZbTriggerStyle } from './models/trigger-style';
import {
  CustomizerChangeDetail,
  CustomizerErrorDetail,
  CustomizerReadyDetail,
  CustomizerSaveDetail,
  SaveResult,
} from './models/events.models';
import { LineExtensionValues, PERSONALIZATION_EXTENSION_ID } from './models/extension-contract';
import { CustomizationPersistence } from './services/customization-persistence.service';
import { DesignPersister } from './services/design-persister.service';
import { DesignSaver, DesignToPersist } from './services/design-saver.service';
import { ExtensionChannel, newInstanceId } from './services/extension-channel';
import { CustomizerError, PrepareError, isAbortError } from './services/errors';
import type { SavePayload } from './services/export.service';
import type { LoadRequest } from './services/load-pipeline.service';
import { ResolveOutcome, StorefrontResolver } from './services/storefront-resolver.service';
import { coerceBoolean, coerceStringList } from './util/coerce';
import {
  DEFAULT_TRIGGER_LABEL,
  SAVED_TRIGGER_LABEL,
  canvasColorResolver,
  coerceTriggerStyle,
  resolveTriggerStyle,
} from './util/trigger-style';
import type { EditorSaveRequest, PersonalizerEditorComponent } from './personalizer-editor.component';

/** Kept for existing importers; see `util/coerce.ts`. */
export { coerceBoolean as coerceDisabled };

function coerceTheme(value: unknown): 'light' | 'dark' | 'auto' {
  return value === 'dark' || value === 'auto' ? value : 'light';
}

function coerceMode(value: unknown): ZbRenderMode | null {
  return value === 'storefront' || value === 'preview' ? value : null;
}

/**
 * Where the component publishes `prepareForCart` on its host element; `main.storefront.ts` exposes it
 * as the element's public `prepareForCart()` method (Angular Elements has no method export).
 */
export const PREPARE_HOOK = Symbol.for('zb-product-customizer.prepareForCart');

type Resolution =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'mapped'; key: string; configId: string; version: number; config: unknown }
  | { kind: 'unmapped' }
  | { kind: 'failed'; message: string };

/** The design the shopper saved, kept after the modal closes so it can be reopened, edited and added to the cart. */
interface SavedDesign {
  payload: SavePayload;
  valuesKey: string;
  templateId: string;
  templateVersion: number;
  /** `<templateId>@<version>`: the saved design is only ever restored into the template it was made for. */
  templateKey: string;
}

interface ResolveRequest {
  apiBaseUrl: string;
  storeId: string;
  productId: string;
  variantId: string | null;
  collectionIds: readonly string[];
}

const sameRequest = (a: ResolveRequest | null, b: ResolveRequest | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.apiBaseUrl === b.apiBaseUrl &&
    a.storeId === b.storeId &&
    a.productId === b.productId &&
    a.variantId === b.variantId &&
    a.collectionIds.join('\n') === b.collectionIds.join('\n'));

function isSaveResult(value: unknown): value is SaveResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['requestId'] === 'string' &&
    (v['status'] === 'success' || v['status'] === 'error') &&
    (v['message'] === undefined || typeof v['message'] === 'string')
  );
}

/** The product id and schema marker of a published configuration, read without validating it (the editor does that). */
function peekConfig(config: unknown): { productId: string | null; schemaVersion2: boolean } {
  const root = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const product = typeof root['product'] === 'object' && root['product'] !== null ? (root['product'] as Record<string, unknown>) : {};
  return {
    productId: typeof product['id'] === 'string' ? product['id'] : null,
    schemaVersion2: root['schemaVersion'] === 2,
  };
}

/**
 * `<zb-product-customizer>`: the storefront shell. It is cheap by design — the personalization editor
 * (canvas rendering, image handling, export) is a separate component that is only downloaded and created
 * when it is needed.
 *
 *  - `storefront` mode (the default when the template is resolved from `product-id`): asks the personalization
 *    API whether the product has a published template, shows a trigger button only if it does, and opens the
 *    editor in a native modal dialog when the button is clicked. Saving persists the design, announces it to the
 *    host and closes the modal; the saved design is restored when the modal is reopened.
 *  - `preview` mode (the default when the host supplies `config` / `config-url`): the editor inline, no trigger.
 *
 * The shell owns everything that crosses the boundary with the host: the inputs and `customizer-*` events, the
 * `zb:event` channel, `prepareForCart()` and the save protocol. Everything is rendered into this component's shadow
 * root with a single stylesheet, so nothing is added to the host page's CSS and host CSS cannot reach the internals.
 */
@Component({
  selector: 'app-product-customizer',
  imports: [NgTemplateOutlet],
  providers: [StorefrontResolver, CustomizationPersistence, DesignPersister, DesignSaver],
  encapsulation: ViewEncapsulation.ShadowDom,
  templateUrl: './product-customizer.component.html',
  styleUrl: './product-customizer.component.scss',
  host: {
    '[attr.theme]': 'theme()',
    '[attr.data-status]': 'status()',
    '[attr.data-save-state]': 'saveState()',
    '[attr.data-mode]': 'effectiveMode()',
    '[attr.data-modal]': 'modalOpen() ? "open" : null',
  },
})
export class ProductCustomizerComponent {
  private static nextId = 0;

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

  // ---- rendering mode and trigger appearance ---------------------------------------------------------
  /** `storefront` (trigger + modal) or `preview` (inline editor); derived from the other inputs when absent. */
  readonly mode = input<ZbRenderMode | null, unknown>(null, { transform: coerceMode });
  /** Builder button style for the trigger (object, or JSON as an attribute). */
  readonly triggerStyle = input<ZbTriggerStyle | null, unknown>(null, { transform: coerceTriggerStyle });

  // ---- resolve-by-product (used only when neither `config` nor `configUrl` is set) -------------
  /** The host's id of the product on this page. */
  readonly productId = input<string | null>(null);
  readonly variantId = input<string | null>(null);
  /** Ids of the collections the product belongs to (array property or comma separated attribute). */
  readonly collectionIds = input<readonly string[], unknown>([], { transform: coerceStringList });
  readonly apiBaseUrl = input<string | null>(null);
  /** Public storefront key of the store; not a secret. */
  readonly storeId = input<string | null>(null);

  // ---- extension contract (docs/extension-platform-contract-v1.md) ------------------------------
  /** Assigned by the host (attribute `instance-id`); generated once per element when absent. */
  readonly instanceId = input<string | null>(null);
  /** Host-defined label of where the element sits (attribute `placement`), echoed by the host, not by events. */
  readonly placement = input<string | null>(null);
  /**
   * The host's Add to cart is the primary action: the design is saved to the personalization API by this
   * element itself (modal Save or `prepareForCart()`), not handed to the host through `customizer-save`.
   */
  readonly hideSave = input<boolean, unknown>(false, { transform: coerceBoolean });

  // ---- public outputs (aliases are the DOM event names) ----------------------------------------
  readonly customizerReady = output<CustomizerReadyDetail>({ alias: 'customizer-ready' });
  readonly customizerChange = output<CustomizerChangeDetail>({ alias: 'customizer-change' });
  readonly customizerSave = output<CustomizerSaveDetail>({ alias: 'customizer-save' });
  readonly customizerError = output<CustomizerErrorDetail>({ alias: 'customizer-error' });

  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly resolver = inject(StorefrontResolver);
  private readonly saver = inject(DesignSaver);
  private readonly generatedInstanceId = newInstanceId();
  private readonly channel = new ExtensionChannel(
    this.hostElement,
    () => this.instanceId() || this.generatedInstanceId,
  );

  // ---- eligibility -----------------------------------------------------------------------------
  private readonly resolution = signal<Resolution>({ kind: 'idle' });
  private readonly retryTick = signal(0);
  private resolveAbort: AbortController | null = null;

  /** True when the host asks for resolution by product rather than supplying a configuration. */
  private readonly productMode = computed(
    () =>
      !this.hasValue(this.config()) &&
      !this.hasValue(this.configUrl()) &&
      !!this.productId() &&
      !!this.apiBaseUrl() &&
      !!this.storeId(),
  );

  protected readonly effectiveMode = computed<ZbRenderMode>(
    () => this.mode() ?? (this.productMode() ? 'storefront' : 'preview'),
  );

  private readonly resolveRequest = computed<ResolveRequest | null>(
    () =>
      this.productMode()
        ? {
            apiBaseUrl: this.apiBaseUrl()!,
            storeId: this.storeId()!,
            productId: this.productId()!,
            variantId: this.variantId() || null,
            collectionIds: this.collectionIds(),
          }
        : null,
    { equal: sameRequest },
  );

  /** What the template says is available for the host's own `config` / `config-url`. */
  private readonly hasDirectConfig = computed(() => this.hasValue(this.config()) || this.hasValue(this.configUrl()));

  /** Which of the shell's own views is showing. */
  protected readonly view = computed<'fallback' | 'hidden' | 'unavailable' | 'trigger' | 'inline'>(() => {
    const resolution = this.resolution();
    if (this.effectiveMode() === 'storefront') {
      if (this.modalOpen()) return 'trigger'; // never pull the dialog out from under the shopper
      if (!this.productMode()) return this.hasDirectConfig() ? 'trigger' : 'hidden';
      switch (resolution.kind) {
        case 'mapped':
          return 'trigger';
        case 'unmapped':
          return 'fallback';
        case 'failed':
          return 'unavailable';
        default:
          return 'hidden'; // eligibility unknown: no button
      }
    }
    return this.productMode() && resolution.kind === 'unmapped' ? 'fallback' : 'inline';
  });

  // ---- the editor (created lazily) ------------------------------------------------------------------
  private readonly anchor = viewChild('editorAnchor', { read: ViewContainerRef });
  private readonly injector = inject(Injector);
  private readonly editorType = signal<typeof PersonalizerEditorComponent | null>(null);
  protected readonly editorLoad = signal<'idle' | 'loading' | 'failed'>('idle');
  protected readonly editor = signal<PersonalizerEditorComponent | null>(null);
  private editorRef: ComponentRef<PersonalizerEditorComponent> | null = null;
  private editorRefAnchor: ViewContainerRef | null = null;

  // ---- modal ------------------------------------------------------------------------------------
  protected readonly titleId = `zbc-modal-title-${++ProductCustomizerComponent.nextId}`;
  protected readonly confirmId = `zbc-discard-${ProductCustomizerComponent.nextId}`;
  protected readonly modalOpen = signal(false);
  protected readonly confirmingDiscard = signal(false);
  /** Polite announcements for assistive technology (saved, saving, changed product). */
  protected readonly announcement = signal('');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly keepEditing = viewChild<ElementRef<HTMLButtonElement>>('keepEditing');
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  /** The configuration (and its key) the open editor was created with; it never follows a re-resolution. */
  private readonly activeConfig = signal<unknown>(null);
  private activeKey = '';
  private readonly restore = signal<{ initialCustomization: unknown; assetMap: LoadRequest['assetMap'] }>({
    initialCustomization: null,
    assetMap: null,
  });
  private readonly ackToEditor = signal<SaveResult | null>(null);
  private closingProgrammatically = false;
  private pressedOnBackdrop = false;

  // ---- save state --------------------------------------------------------------------------------------
  protected readonly saved = signal<SavedDesign | null>(null);
  private pendingHostSave: EditorSaveRequest | null = null;
  private preparing: Promise<LineExtensionValues> | null = null;

  private destroyed = false;
  private lastGateKey = '';
  private lastAnnounced = '';
  private renderedSent = false;

  // ---- derived view state ------------------------------------------------------------------------------
  private readonly colorResolver = canvasColorResolver();
  protected readonly appearance = computed(() => resolveTriggerStyle(this.triggerStyle(), this.colorResolver));
  protected readonly triggerLabel = computed(
    () => this.appearance().label ?? (this.saved() ? SAVED_TRIGGER_LABEL : DEFAULT_TRIGGER_LABEL),
  );

  /** The element-level status (`data-status`): what a host or a test can read without looking inside. */
  protected readonly status = computed<string>(() => {
    const resolution = this.resolution();
    if (this.productMode()) {
      if (resolution.kind === 'unmapped') return 'not-personalizable';
      if (resolution.kind === 'failed') return 'invalid-config';
      if (resolution.kind !== 'mapped' && !this.modalOpen()) return 'loading';
    }
    if (this.effectiveMode() === 'storefront') return this.view() === 'trigger' ? 'ready' : 'awaiting-config';
    if (this.editorLoad() === 'failed') return 'asset-error';
    return this.editor()?.status() ?? 'loading';
  });

  protected readonly saveState = computed<string>(() => this.editor()?.saveState() ?? (this.saved() ? 'saved' : 'idle'));

  protected readonly hostDisabled = this.disabled;

  /** What the host should know about adding to cart (only meaningful when the element resolves its own template). */
  private readonly gateState = computed<{ allowed: boolean; reason?: string } | null>(() => {
    if (!this.productMode()) return null;
    const resolution = this.resolution();
    if (resolution.kind === 'unmapped') return { allowed: true }; // nothing to personalize here
    if (resolution.kind === 'failed') {
      return { allowed: false, reason: 'Personalization is temporarily unavailable. Please try again.' };
    }
    if (resolution.kind !== 'mapped') return { allowed: false, reason: 'Personalization is still loading.' };
    if (this.hostDisabled()) return { allowed: false, reason: 'Personalization is unavailable right now.' };
    if (this.effectiveMode() === 'storefront') {
      return this.saved() ? { allowed: true } : { allowed: false, reason: 'Personalize this product to add it to your cart.' };
    }
    const editor = this.editor();
    return editor ? editor.gate() : { allowed: false, reason: 'Personalization is still loading.' };
  });

  /** What the shell itself shows inline while the editor is not (yet) on screen. */
  protected readonly inlinePanel = computed<'loading' | 'resolve-failed' | 'editor-failed' | null>(() => {
    const resolution = this.resolution();
    if (this.productMode()) {
      if (resolution.kind === 'failed') return 'resolve-failed';
      if (resolution.kind !== 'mapped') return 'loading';
    }
    if (this.editorLoad() === 'failed') return 'editor-failed';
    return this.editor() ? null : 'loading';
  });

  protected readonly resolveFailureMessage = computed(() => {
    const resolution = this.resolution();
    return resolution.kind === 'failed' ? resolution.message : '';
  });

  /** Inputs of the editor that follow the shell's inputs. */
  private readonly editorInputs = computed(() => {
    const storefront = this.effectiveMode() === 'storefront';
    const productMode = this.productMode();
    const resolution = this.resolution();
    const hostOrigins = this.allowedAssetOrigins();
    const apiOrigin = productMode ? this.originOf(this.apiBaseUrl()) : null;
    const restore = this.restore();
    return {
      config: storefront ? this.activeConfig() : productMode ? (resolution.kind === 'mapped' ? resolution.config : null) : this.config(),
      configUrl: productMode ? null : this.configUrl(),
      baseUrl: this.baseUrl(),
      // An empty list already means "any http(s) origin"; only extend a restrictive list.
      allowedAssetOrigins: productMode && apiOrigin && hostOrigins && hostOrigins.length > 0 ? [...hostOrigins, apiOrigin] : hostOrigins,
      allowLocalAssets: this.allowLocalAssets(),
      initialCustomization: storefront ? restore.initialCustomization : this.initialCustomization(),
      assetMap: storefront ? restore.assetMap : this.assetMap(),
      disabled: this.disabled(),
      saveResult: this.ackToEditor(),
      // In the modal the editor's Save button is always the way to confirm the design.
      hideSave: storefront ? false : this.hideSave(),
    };
  });

  /** An editor is wanted inline once its configuration is known, and in the modal while it is open. */
  private readonly editorWanted = computed(() => {
    if (this.effectiveMode() === 'storefront') return this.modalOpen();
    return !this.productMode() || this.resolution().kind === 'mapped';
  });

  constructor() {
    // Ask the API which published template is mapped to this product/variant/collections.
    effect(() => {
      const request = this.resolveRequest();
      this.retryTick();
      untracked(() => void this.startResolve(request));
    });

    // Tell the host what the eligibility check found.
    effect(() => {
      const resolution = this.resolution();
      const storefront = this.effectiveMode() === 'storefront';
      untracked(() => this.announceEligibility(resolution, storefront));
    });

    // Create, feed and destroy the editor.
    effect(() => {
      const anchor = this.anchor();
      const wanted = this.editorWanted();
      const type = this.editorType();
      const load = this.editorLoad();
      untracked(() => this.syncEditor(anchor, wanted, type, load));
    });
    effect(() => {
      const inputs = this.editorInputs();
      untracked(() => this.pushInputs(inputs));
    });

    // Host acknowledgements.
    effect(() => {
      const result = this.saveResult();
      if (result !== null && result !== undefined) untracked(() => this.onHostSaveResult(result));
    });

    // `gate`: the host disables Add to cart while the design cannot be added yet.
    effect(() => {
      const gate = this.gateState();
      if (!gate) return;
      untracked(() => this.sendGate(gate));
    });

    // `rendered`: once per instance, after the first thing the shopper can use is on screen.
    effect(() => {
      if (this.renderedSent || this.effectiveMode() !== 'storefront' || this.view() !== 'trigger') return;
      this.renderedSent = true;
      untracked(() => requestAnimationFrame(() => !this.destroyed && this.channel.emit('rendered', {})));
    });

    // A different product, store or API invalidates what the shopper saved and any open modal.
    effect(() => {
      this.apiBaseUrl();
      this.storeId();
      this.productId();
      untracked(() => this.resetForNewContext());
    });

    // The discard question takes focus, on its safe answer.
    effect(() => {
      const keep = this.keepEditing();
      if (keep && this.confirmingDiscard()) untracked(() => keep.nativeElement.focus());
    });

    // Leaving storefront mode (or losing the trigger) closes the modal.
    effect(() => {
      if (this.effectiveMode() !== 'storefront' && this.modalOpen()) untracked(() => this.closeModal());
    });

    // Saving to the personalization API: the saver asks for the host's product context when a save starts and tells
    // the host (once per customization) when one was created.
    this.saver.bind({
      context: () => ({
        apiBaseUrl: this.apiBaseUrl()!,
        storeId: this.storeId()!,
        productId: this.productId() ?? '',
        variantId: this.variantId() || null,
        collectionIds: this.collectionIds(),
      }),
      saved: (data) => this.channel.emit(`${PERSONALIZATION_EXTENSION_ID}.saved`, data),
    });
    // The host reports the line was added: this customization is now spoken for (one customization is
    // ordered at most once), so the next add must save a fresh one.
    const stopHostEvents = this.channel.onHostEvent((type) => {
      if (type === 'cart.line-added') this.saver.forget();
    });

    (this.hostElement as unknown as Record<symbol, unknown>)[PREPARE_HOOK] = () => this.prepareForCart();

    inject(DestroyRef).onDestroy(() => {
      stopHostEvents();
      delete (this.hostElement as unknown as Record<symbol, unknown>)[PREPARE_HOOK];
      this.teardown();
    });
  }

  // ---- resolve by product ---------------------------------------------------------------------

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

  protected retry(kind: 'resolve' | 'editor'): void {
    if (kind === 'resolve') this.retryResolve();
    else this.editorLoad.set('idle');
  }

  private async startResolve(request: ResolveRequest | null): Promise<void> {
    this.resolveAbort?.abort();
    if (!request) {
      if (this.resolution().kind !== 'idle') this.resolution.set({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    this.resolveAbort = controller;
    const previous = this.resolution();
    // Inline, keep showing the current design while a variant/collection change is re-checked. In the storefront the
    // answer for the OLD context says nothing about the new one, so the button goes away until it is known.
    if (previous.kind !== 'mapped' || this.effectiveMode() === 'storefront') this.resolution.set({ kind: 'resolving' });
    let outcome: ResolveOutcome;
    try {
      outcome = await this.resolver.resolve(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || this.destroyed) return;
      const known = error instanceof CustomizerError;
      const message = known ? error.message : 'The personalization service could not be reached.';
      this.resolution.set({ kind: 'failed', message });
      this.emitError({
        code: known ? error.code : 'config-load-failed',
        message,
        recoverable: known ? error.recoverable : true,
      });
      this.onEligibilityLost('failed');
      return;
    }
    if (controller.signal.aborted || this.destroyed) return;
    if (outcome.kind === 'unmapped') {
      this.resolution.set({ kind: 'unmapped' });
      this.onEligibilityLost('unmapped');
      return;
    }
    const key = `${outcome.configId}@${outcome.version}`;
    // Same template and version as before: keep the loaded design (and the shopper's input).
    if (previous.kind === 'mapped' && previous.key === key && this.effectiveMode() === 'preview') return;
    this.resolution.set({ kind: 'mapped', key, configId: outcome.configId, version: outcome.version, config: outcome.config });
    this.onTemplateResolved(key);
  }

  /** The product has no usable template (any more): what was saved for it cannot be used. */
  private onEligibilityLost(kind: 'failed' | 'unmapped'): void {
    if (kind === 'unmapped') this.dropSavedDesign();
    if (this.modalOpen() && kind === 'unmapped') this.closeModal('This product can no longer be personalized, so your changes were not kept.');
  }

  /** A template was resolved: an open modal or a saved design built for a different template is obsolete. */
  private onTemplateResolved(key: string): void {
    const saved = this.saved();
    if (saved && saved.templateKey !== key) this.dropSavedDesign();
    if (this.modalOpen() && this.activeKey !== key) {
      this.closeModal('This product changed, so your previous personalization was cleared.');
    }
  }

  private resetForNewContext(): void {
    this.dropSavedDesign();
    if (this.modalOpen()) this.closeModal('This product changed, so your previous personalization was cleared.');
  }

  private dropSavedDesign(): void {
    this.saved.set(null);
    this.pendingHostSave = null;
    this.ackToEditor.set(null);
    this.saver.reset();
  }

  // ---- events the host listens to -------------------------------------------------------------

  /** `ready` (both flavours) once the element knows whether the product is personalizable. */
  private announceEligibility(resolution: Resolution, storefront: boolean): void {
    if (resolution.kind === 'unmapped') {
      this.announce('unmapped', () => ({ productId: this.productId() ?? '', templateId: '', templateVersion: 0, personalizable: false }));
    } else if (resolution.kind === 'mapped' && storefront) {
      // The editor has not been downloaded yet, so say what is known without it.
      const peeked = peekConfig(resolution.config);
      this.announce(`mapped:${resolution.key}`, () => ({
        productId: peeked.productId ?? this.productId() ?? '',
        templateId: resolution.configId,
        templateVersion: resolution.version,
        ...(peeked.schemaVersion2 ? { schemaVersion: 2 as const } : {}),
        personalizable: true,
      }));
    } else {
      this.lastAnnounced = ''; // the next answer is news again
    }
  }

  private announce(key: string, detail: () => CustomizerReadyDetail): void {
    if (key === this.lastAnnounced) return;
    this.lastAnnounced = key;
    this.emitReady(detail());
  }

  private emitReady(detail: CustomizerReadyDetail): void {
    if (this.destroyed) return;
    this.customizerReady.emit(detail);
    // Contract v1 `ready`: `available: false` tells the host to collapse the slot.
    this.channel.emit('ready', { available: detail.personalizable !== false });
  }

  private emitError(detail: CustomizerErrorDetail): void {
    if (this.destroyed) return;
    this.customizerError.emit(detail);
    // `message` is deliberately not forwarded: contract v1 `error` carries a code only.
    this.channel.emit('error', { code: detail.code, recoverable: detail.recoverable });
  }

  private sendGate(gate: { allowed: boolean; reason?: string }): void {
    const key = `${gate.allowed}|${gate.reason ?? ''}`;
    if (key === this.lastGateKey || this.destroyed) return;
    this.lastGateKey = key;
    this.channel.emit('gate', gate);
  }

  // ---- the editor's life -----------------------------------------------------------------------

  private syncEditor(
    anchor: ViewContainerRef | undefined,
    wanted: boolean,
    type: typeof PersonalizerEditorComponent | null,
    load: 'idle' | 'loading' | 'failed',
  ): void {
    if (this.destroyed) return;
    if (!wanted || !anchor) {
      this.destroyEditor();
      return;
    }
    if (this.editorRef && this.editorRefAnchor !== anchor) this.destroyEditor();
    if (this.editorRef) return;
    if (!type) {
      if (load === 'idle') this.loadEditorChunk();
      return;
    }
    const ref = anchor.createComponent(type, { injector: this.injector });
    this.editorRef = ref;
    this.editorRefAnchor = anchor;
    this.pushInputs(this.editorInputs());
    const editor = ref.instance;
    editor.editorReady.subscribe((detail) => this.onEditorReady(detail));
    editor.editorChange.subscribe((detail) => !this.destroyed && this.customizerChange.emit(detail));
    editor.editorSave.subscribe((request) => this.onEditorSave(request));
    editor.editorError.subscribe((detail) => this.emitError(detail));
    ref.onDestroy(() => {
      if (this.editorRef === ref) {
        this.editorRef = null;
        this.editorRefAnchor = null;
        this.editor.set(null);
      }
    });
    this.editor.set(editor);
  }

  private pushInputs(inputs: Record<string, unknown>): void {
    const ref = this.editorRef;
    if (!ref) return;
    for (const [name, value] of Object.entries(inputs)) ref.setInput(name, value);
  }

  private destroyEditor(): void {
    const ref = this.editorRef;
    if (!ref) return;
    this.editorRef = null;
    this.editorRefAnchor = null;
    this.editor.set(null);
    ref.destroy();
  }

  /** The editor is a separate chunk: fetched the first time one is needed, never before. */
  private loadEditorChunk(): void {
    this.editorLoad.set('loading');
    import('./personalizer-editor.component').then(
      (module) => {
        if (this.destroyed) return;
        this.editorType.set(module.PersonalizerEditorComponent);
        this.editorLoad.set('idle');
      },
      () => {
        if (this.destroyed) return;
        this.editorLoad.set('failed');
        this.emitError({ code: 'unexpected', message: 'The personalizer could not be loaded.', recoverable: true });
      },
    );
  }

  private onEditorReady(detail: CustomizerReadyDetail): void {
    // In the storefront the eligibility announcement already told the host; the modal opening is not news.
    if (this.effectiveMode() === 'storefront') return;
    this.emitReady({ ...detail, ...(this.productMode() ? { personalizable: true } : {}) });
    if (!this.renderedSent) {
      this.renderedSent = true;
      requestAnimationFrame(() => !this.destroyed && this.channel.emit('rendered', {}));
    }
  }

  // ---- the modal -------------------------------------------------------------------------------

  protected open(): void {
    if (this.modalOpen() || this.hostDisabled() || this.view() !== 'trigger') return;
    const resolution = this.resolution();
    if (this.productMode() && resolution.kind !== 'mapped') return;
    const saved = this.saved();
    this.activeConfig.set(this.productMode() && resolution.kind === 'mapped' ? resolution.config : this.config());
    this.activeKey = resolution.kind === 'mapped' ? resolution.key : '';
    this.restore.set(
      saved
        ? {
            initialCustomization: saved.payload.customization,
            // The saved design's own image files: restored without going back to the network.
            assetMap: new Map(saved.payload.assets.map((asset) => [asset.assetId, asset.blob])),
          }
        : { initialCustomization: this.initialCustomization(), assetMap: this.assetMap() },
    );
    this.ackToEditor.set(null);
    this.pendingHostSave = null;
    this.announcement.set('');
    this.modalOpen.set(true);
    const dialog = this.dialog()?.nativeElement;
    if (dialog && !dialog.open) dialog.showModal();
    // The dialog's content is rendered after this click handler returns; focus lands on its first control.
    afterNextRender(() => this.closeButton()?.nativeElement.focus(), { injector: this.injector });
  }

  /** The shopper (or the browser) asked to close. Never discards or interrupts silently. */
  protected requestClose(): void {
    if (!this.modalOpen()) return;
    if (this.confirmingDiscard()) {
      this.keepEditingDesign();
      return;
    }
    const editor = this.editor();
    const saveState = editor?.saveState();
    if (saveState === 'exporting' || saveState === 'awaiting-host') {
      this.announcement.set('Your design is being saved. Please wait a moment.');
      return;
    }
    if (editor?.dirty()) {
      this.confirmingDiscard.set(true);
      return;
    }
    this.closeModal();
  }

  protected keepEditingDesign(): void {
    this.confirmingDiscard.set(false);
  }

  protected discardAndClose(): void {
    this.closeModal();
  }

  private closeModal(message?: string): void {
    this.confirmingDiscard.set(false);
    if (!this.modalOpen()) return;
    this.modalOpen.set(false);
    this.pendingHostSave = null;
    if (message) this.announcement.set(message);
    const dialog = this.dialog()?.nativeElement;
    if (dialog?.open) {
      this.closingProgrammatically = true;
      dialog.close();
    }
    // The browser restores focus to what opened the dialog; do not rely on it.
    this.trigger()?.nativeElement.focus();
  }

  protected onCancel(event: Event): void {
    event.preventDefault(); // Escape: ask first instead of letting the browser close the dialog
    this.requestClose();
  }

  /** The browser closed the dialog itself (a second Escape ignores `cancel`): keep our state and its truth aligned. */
  protected onNativeClose(): void {
    if (this.closingProgrammatically) {
      this.closingProgrammatically = false;
      return;
    }
    if (!this.modalOpen()) return;
    const editor = this.editor();
    const busy = editor?.saveState() === 'exporting' || editor?.saveState() === 'awaiting-host';
    if (busy || editor?.dirty()) {
      this.dialog()?.nativeElement.showModal();
      this.requestClose();
    } else {
      this.modalOpen.set(false);
      this.confirmingDiscard.set(false);
      this.trigger()?.nativeElement.focus();
    }
  }

  protected onBackdropDown(event: PointerEvent): void {
    this.pressedOnBackdrop = event.target === this.dialog()?.nativeElement;
  }

  protected onBackdropClick(event: MouseEvent): void {
    // A drag that starts in the panel and ends on the backdrop is not a click on the backdrop.
    if (this.pressedOnBackdrop && event.target === this.dialog()?.nativeElement) this.requestClose();
    this.pressedOnBackdrop = false;
  }

  // ---- saving ----------------------------------------------------------------------------------

  /** The editor froze a design for saving. Who persists it depends on who owns the save: the host, or this element. */
  private onEditorSave(request: EditorSaveRequest): void {
    if (this.destroyed) return;
    if (this.effectiveMode() === 'storefront' && this.hideSave()) {
      void this.saveFromModal(request);
      return;
    }
    // Host-acknowledged: the host persists and answers with `saveResult`.
    this.pendingHostSave = request;
    this.customizerSave.emit(request.detail);
  }

  private onHostSaveResult(result: unknown): void {
    if (!isSaveResult(result)) return;
    this.ackToEditor.set({ ...result }); // a new object each time, so a repeated answer is still seen
    const pending = this.pendingHostSave;
    if (!pending || pending.detail.requestId !== result.requestId) return;
    this.pendingHostSave = null;
    if (result.status === 'success') this.designSaved(pending);
  }

  /** The element persists the design itself (extension-managed saving), then answers the editor on the host's behalf. */
  private async saveFromModal(request: EditorSaveRequest): Promise<void> {
    const { requestId, ...payload } = request.detail;
    try {
      await this.saver.save({
        payload,
        valuesKey: request.valuesKey,
        templateId: request.templateId,
        templateVersion: request.templateVersion,
        source: 'save',
      });
      if (this.destroyed) return;
      this.ackToEditor.set({ requestId, status: 'success', message: 'Customization saved.' });
      this.designSaved(request);
    } catch (error) {
      if (this.destroyed) return;
      this.ackToEditor.set({ requestId, status: 'error', message: this.shopperError(error).message });
    }
  }

  /** A save was accepted: remember it, tell the shopper, and get the modal out of the way. */
  private designSaved(request: EditorSaveRequest): void {
    // Inline there is no trigger to come back to: the editor itself is the place the design lives.
    if (this.effectiveMode() !== 'storefront') return;
    const { requestId, ...payload } = request.detail;
    void requestId;
    this.saved.set({
      payload,
      valuesKey: request.valuesKey,
      templateId: request.templateId,
      templateVersion: request.templateVersion,
      templateKey: `${request.templateId}@${request.templateVersion}`,
    });
    this.announcement.set('Your personalization was saved.');
    if (this.modalOpen()) this.closeModal('Your personalization was saved.');
  }

  /** Only messages written for shoppers leave; everything else is made generic. */
  private shopperError(error: unknown): PrepareError {
    if (error instanceof PrepareError) return error;
    if (error instanceof CustomizerError) {
      this.emitError({ code: error.code, message: error.message, recoverable: error.recoverable });
      return new PrepareError(error.message);
    }
    if (isAbortError(error)) return new PrepareError('Saving was cancelled.');
    this.emitError({ code: 'save-failed', message: 'The design could not be saved.', recoverable: true });
    return new PrepareError('Your design could not be saved. Please try again.');
  }

  // ---- host command: prepare for cart (contract v1, section 5.2) --------------------------------

  /**
   * Called by the host when the shopper adds to cart. Saves the design to the personalization API and
   * resolves with the line extension values (`{ customizationId, customizedImageUrl? }`) the platform
   * attaches to the cart line. Rejects with a shopper-safe message to cancel the add. Concurrent calls share one save, and
   * the same unchanged design reuses its customization.
   *
   * Inline, the design is whatever the editor shows now. In the storefront it is the design the shopper
   * saved in the modal (which the modal's Save may already have persisted); a product the shopper has not
   * personalized is refused rather than added as the plain product.
   */
  prepareForCart(): Promise<LineExtensionValues> {
    if (this.destroyed) return Promise.reject(new Error('The personalization is no longer available.'));
    if (!this.productMode()) {
      return Promise.reject(new Error('Personalization is not set up for this page.'));
    }
    const resolution = this.resolution();
    if (resolution.kind === 'unmapped') return Promise.resolve({}); // nothing to attach
    if (resolution.kind !== 'mapped') {
      return Promise.reject(new Error('Personalization is still loading. Please wait a moment.'));
    }
    if (this.hostDisabled()) {
      return Promise.reject(new Error('Personalization is unavailable right now.'));
    }
    this.preparing ??= this.runPrepare().finally(() => (this.preparing = null));
    return this.preparing;
  }

  private async runPrepare(): Promise<LineExtensionValues> {
    try {
      // A shopper editing mid-save would otherwise get a customization of a design they have left.
      for (let attempt = 0; attempt < 2; attempt++) {
        const editor = this.editor();
        let design: DesignToPersist;
        if (editor) {
          if (editor.status() !== 'ready') throw new PrepareError('Personalization is still loading. Please wait a moment.');
          const gate = editor.gate();
          if (!gate.allowed) throw new PrepareError(gate.reason ?? 'Please complete the personalization before adding to cart.');
          design = { ...(await editor.exportCurrent()), source: 'cart' };
        } else if (this.effectiveMode() === 'storefront') {
          const saved = this.saved();
          if (!saved) throw new PrepareError('Personalize this product before adding it to your cart.');
          design = { payload: saved.payload, valuesKey: saved.valuesKey, templateId: saved.templateId, templateVersion: saved.templateVersion, source: 'cart' };
        } else {
          throw new PrepareError('Personalization is still loading. Please wait a moment.');
        }
        const persisted = await this.saver.save(design);
        if (editor && this.editor() === editor && editor.currentKey() !== design.valuesKey) continue; // the design changed while saving: save the new one
        return {
          customizationId: persisted.customizationId,
          ...(persisted.customizedImageUrl ? { customizedImageUrl: persisted.customizedImageUrl } : {}),
        };
      }
      throw new PrepareError('Your design changed while it was being saved. Please try again.');
    } catch (error) {
      throw this.shopperError(error);
    }
  }

  // ---- teardown ---------------------------------------------------------------------------------

  private teardown(): void {
    this.destroyed = true;
    this.resolveAbort?.abort();
    this.saver.dispose();
    this.destroyEditor(); // the dialog leaves the top layer with its element
  }
}
