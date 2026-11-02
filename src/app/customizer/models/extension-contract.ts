/**
 * Extension Platform Contract v1, client side (docs/extension-platform-contract-v1.md, sections 4–5).
 *
 * These types are GENERIC: they describe how any ZenBasket extension talks to its host page. Only
 * `PERSONALIZATION_EXTENSION_ID` names this extension. A host bridge written against them needs no
 * knowledge of personalization, and `<zb-product-customizer>` is one implementation among many.
 *
 * Compiled to `types/extension-contract.d.ts` by `npm run build:element`.
 */

export const ZB_CONTRACT_VERSION = 1;

/** The single DOM event extensions dispatch to their host (bubbles, composed). */
export const ZB_EVENT = 'zb:event';
/** The single DOM event the host dispatches on an element to notify it (same envelope). */
export const ZB_HOST_EVENT = 'zb:host-event';

/** This extension's id: the namespace of its custom events and line extensions. */
export const PERSONALIZATION_EXTENSION_ID = 'personalization';
export const STOREFRONT_PRODUCT_SLOT = 'storefront.product.detail.block';

/** Every event an extension sends to its host. `type` is a standard type or `<extensionId>.<name>`. */
export interface ZbEvent<T = unknown> {
  contract: typeof ZB_CONTRACT_VERSION;
  /** The manifest id; the host drops events whose id does not match the slot's extension. */
  extensionId: string;
  /** Unique per rendered instance; stable until it is removed from the page. */
  instanceId: string;
  slot: string;
  type: string;
  data: T;
  /** Epoch milliseconds. */
  ts: number;
}

/** Standard event types the platform understands (section 5.1). */
export interface ZbStandardEventData {
  /** `available: false` → the host collapses the slot. */
  ready: { available: boolean };
  /** Sent once per instance, after first paint. */
  rendered: Record<string, never>;
  /** While `allowed` is false the host disables the primary action (Add to cart). */
  gate: { allowed: boolean; reason?: string };
  /** Never contains shopper content. */
  error: { code: string; recoverable: boolean };
}

/** Line extension values an element hands back from `prepareForCart()` (keys without the namespace prefix). */
export type LineExtensionValues = Readonly<Record<string, string>>;

/** The method a host calls on an element when the shopper adds to cart (section 5.2). */
export interface PrepareForCart {
  /**
   * Does whatever the extension needs before the cart line is created (e.g. saves the design) and
   * resolves with the line extension values. Rejects with an `Error` whose message is safe to show the
   * shopper to cancel the add. Resolves `{}` when there is nothing to attach.
   */
  prepareForCart(): Promise<LineExtensionValues>;
}
