/**
 * Public declaration of the `<zb-product-customizer>` custom element: properties, attributes
 * and DOM events. Compiled to `types/element-contract.d.ts` by `npm run build:element`.
 */

import type { CustomizerConfig } from './config.models';
import type { ProductConfig } from './product.models';
import type { AssetMapInput, Customization } from './draft.models';
import type { LineExtensionValues, ZbEvent } from './extension-contract';
import type {
  CustomizerChangeDetail,
  CustomizerErrorDetail,
  CustomizerReadyDetail,
  CustomizerSaveDetail,
  SaveResult,
} from './events.models';

export const CUSTOMIZER_TAG = 'zb-product-customizer';

/** Event name -> `event.detail` type. Events do not bubble; listen on the element itself. */
export interface ZbProductCustomizerEventMap {
  /**
   * Extension Platform Contract v1 envelope (`ready`, `rendered`, `gate`, `error`, `personalization.saved`).
   * Unlike the `customizer-*` events below it BUBBLES and is composed, so a host bridge can listen once on
   * `document`. See `extension-contract.ts` and docs/extension-platform-contract-v1.md.
   */
  'zb:event': CustomEvent<ZbEvent>;
  'customizer-ready': CustomEvent<CustomizerReadyDetail>;
  'customizer-change': CustomEvent<CustomizerChangeDetail>;
  'customizer-save': CustomEvent<CustomizerSaveDetail>;
  'customizer-error': CustomEvent<CustomizerErrorDetail>;
}

export interface ZbProductCustomizerElement extends HTMLElement {
  /**
   * Full configuration object: schema version 2 (`ProductConfig`) or the original version 1
   * (`CustomizerConfig`). Replace rather than mutate. Exclusive with `configUrl`.
   */
  config: ProductConfig | CustomizerConfig | null;
  /** URL of a JSON configuration (attribute `config-url`). Exclusive with `config`. */
  configUrl: string | null;
  /** Base for relative asset paths in object configuration (attribute `base-url`). */
  baseUrl: string | null;
  /** Saved draft to restore; must match product, template id and template version. */
  initialCustomization: Customization | null;
  /** Durable URLs or Blobs for the asset ids found in `initialCustomization`. */
  assetMap: AssetMapInput | null;
  /** Host-controlled allow-list of asset origins (the page's own origin is always allowed). */
  allowedAssetOrigins: readonly string[] | null;
  /**
   * Permits `idb:` and inline `data:image/` sources in the configuration. Only for the standalone
   * authoring app, whose assets live in the browser; leave off for hosted configurations.
   */
  allowLocalAssets: boolean;
  /** Disables Save and all inputs (attribute `disabled`). */
  disabled: boolean;
  /** Host acknowledgement of a `customizer-save` request. */
  saveResult: SaveResult | null;
  /** Appearance (attribute `theme`): `light` (default), `dark`, or `auto` (follows `prefers-color-scheme`). */
  theme: 'light' | 'dark' | 'auto';

  // ---- resolve by product: used when neither `config` nor `configUrl` is set ---------------------
  /** The host's id of the product on this page (attribute `product-id`). */
  productId: string | null;
  /** The host's currently selected variant id (attribute `variant-id`). A variant mapping wins over a product mapping. */
  variantId: string | null;
  /** Collections the product belongs to (property: string[]; attribute `collection-ids`: comma separated). */
  collectionIds: readonly string[];
  /** Assigned by the host (attribute `instance-id`); the element generates one when absent. Echoed in every `zb:event`. */
  instanceId: string | null;
  /** Host-defined label of where the element sits, e.g. `product-detail` (attribute `placement`). */
  placement: string | null;
  /** Hides the element's own Save button: the host's Add to cart is the primary action (attribute `hide-save`). */
  hideSave: boolean;
  /**
   * Host command (contract v1, section 5.2): call when the shopper adds to cart. Saves the design to the
   * personalization API and resolves with the cart line extension values, `{ customizationId }`; resolves
   * `{}` when the product has no personalization. Rejects with an `Error` whose message is safe to show to
   * the shopper (the add should then be cancelled). Concurrent calls share one save; an unchanged design
   * reuses its customization until the host dispatches `zb:host-event` `cart.line-added`.
   */
  prepareForCart(): Promise<LineExtensionValues>;
  /** Base URL of the personalization API (attribute `api-base-url`). */
  apiBaseUrl: string | null;
  /** Public storefront key of the store (attribute `store-id`); identifies the store, grants nothing. */
  storeId: string | null;

  addEventListener<K extends keyof ZbProductCustomizerEventMap>(
    type: K,
    listener: (this: ZbProductCustomizerElement, ev: ZbProductCustomizerEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof ZbProductCustomizerEventMap>(
    type: K,
    listener: (this: ZbProductCustomizerElement, ev: ZbProductCustomizerEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'zb-product-customizer': ZbProductCustomizerElement;
  }
}
