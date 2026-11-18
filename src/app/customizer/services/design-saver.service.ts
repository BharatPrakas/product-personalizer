import { Service, inject } from '@angular/core';
import type { PersonalizationSavedData } from '../models/extension-contract';
import { DesignPersister } from './design-persister.service';
import type { SavePayload } from './export.service';

/** Where a design is saved to: the host's product context at the moment the save starts. */
export interface SaveContext {
  apiBaseUrl: string;
  storeId: string;
  productId: string;
  variantId: string | null;
  collectionIds: readonly string[];
}

/** A frozen design on its way to the API. */
export interface DesignToPersist {
  payload: SavePayload;
  /** Key of the draft values the payload was built from. */
  valuesKey: string;
  templateId: string;
  templateVersion: number;
  /** `save`: the shopper pressed Save in the modal; `cart`: `prepareForCart()` asked for it. */
  source: PersonalizationSavedData['source'];
}

/** What a persisted design is known by. */
export interface SavedCustomization {
  /** Template, variant and draft values: the same key means the same design. */
  key: string;
  customizationId: string;
  expiresAt: string;
  productId: string;
  variantId: string | null;
}

/** A saved customization stays reusable for the same design until the host reports the line added. */
interface Remembered {
  key: string;
  customizationId: string;
  /** Epoch ms after which the server-side customization may have expired. */
  validUntil: number;
}

const FALLBACK_REUSE_MS = 60 * 60 * 1000;

export interface SaverHost {
  context(): SaveContext;
  /** Called once per customization that was really created (never for a reused one). */
  saved(data: PersonalizationSavedData): void;
}

/**
 * Saves designs to the personalization API on behalf of one element, once.
 *
 *  - The same design (template, variant, values) is saved at most once: concurrent callers (a modal Save and an
 *    Add to cart) share one request, and a design that is already saved is reused until `forget()`.
 *  - A request remembers its result in the same step that ends it, so no caller can find "no request open and
 *    nothing saved" while a save is finishing.
 *  - `reset()` (another product, store or API) makes requests that are still running forget where they came from:
 *    their customization is not offered for the new context.
 */
@Service({ autoProvided: false })
export class DesignSaver {
  private readonly persister = inject(DesignPersister);
  private host: SaverHost | null = null;
  private remembered: Remembered | null = null;
  private inflight: { key: string; promise: Promise<SavedCustomization> } | null = null;
  private abort: AbortController | null = null;
  private generation = 0;

  bind(host: SaverHost): void {
    this.host = host;
  }

  save(design: DesignToPersist): Promise<SavedCustomization> {
    const host = this.host;
    if (!host) return Promise.reject(new Error('The design saver is not bound.'));
    const context = host.context();
    const key = `${design.templateId}@${design.templateVersion}|${context.variantId ?? ''}|${design.valuesKey}`;
    if (this.remembered && this.remembered.key === key && this.remembered.validUntil > Date.now()) {
      return Promise.resolve({
        key,
        customizationId: this.remembered.customizationId,
        expiresAt: '',
        productId: context.productId,
        variantId: context.variantId,
      });
    }
    if (this.inflight?.key === key) return this.inflight.promise;

    const controller = new AbortController();
    this.abort = controller;
    const generation = this.generation;
    const promise: Promise<SavedCustomization> = this.persister
      .persist(
        {
          target: { apiBaseUrl: context.apiBaseUrl, storeId: context.storeId },
          productId: context.productId,
          variantId: context.variantId,
          collectionIds: context.collectionIds,
          templateId: design.templateId,
          templateVersion: design.templateVersion,
        },
        design.payload,
        controller.signal,
      )
      .then((created) => {
        // Only the identifier is kept: the access token the API also returns is never needed here.
        const result: SavedCustomization = {
          key,
          customizationId: created.customizationId,
          expiresAt: created.expiresAt,
          productId: context.productId,
          variantId: context.variantId,
        };
        if (generation === this.generation) this.remember(result, design, host);
        return result;
      })
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
        if (this.abort === controller) this.abort = null;
      });
    this.inflight = { key, promise };
    return promise;
  }

  /** The host added the line: this customization is spoken for, the next add must save a new one. */
  forget(): void {
    this.remembered = null;
  }

  /** Another product, store or API: nothing saved so far applies, and requests still running do not count. */
  reset(): void {
    this.generation++;
    this.remembered = null;
    this.inflight = null;
    this.abort?.abort();
  }

  /** The element is going away. */
  dispose(): void {
    this.reset();
    this.host = null;
  }

  private remember(result: SavedCustomization, design: DesignToPersist, host: SaverHost): void {
    const expires = Date.parse(result.expiresAt);
    this.remembered = {
      key: result.key,
      customizationId: result.customizationId,
      validUntil: Number.isFinite(expires) ? expires - 60_000 : Date.now() + FALLBACK_REUSE_MS,
    };
    host.saved({
      customizationId: result.customizationId,
      templateId: design.templateId,
      templateVersion: design.templateVersion,
      productId: result.productId,
      ...(result.variantId ? { variantId: result.variantId } : {}),
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      source: design.source,
    });
  }
}
