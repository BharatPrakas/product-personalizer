/**
 * Public declaration of the `<zb-product-customizer>` custom element: properties, attributes
 * and DOM events. Compiled to `types/element-contract.d.ts` by `npm run build:element`.
 */

import type { CustomizerConfig } from './config.models';
import type { AssetMapInput, Customization } from './draft.models';
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
  'customizer-ready': CustomEvent<CustomizerReadyDetail>;
  'customizer-change': CustomEvent<CustomizerChangeDetail>;
  'customizer-save': CustomEvent<CustomizerSaveDetail>;
  'customizer-error': CustomEvent<CustomizerErrorDetail>;
}

export interface ZbProductCustomizerElement extends HTMLElement {
  /** Full configuration object. Replace rather than mutate. Exclusive with `configUrl`. */
  config: CustomizerConfig | null;
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
  /** Disables Save and all inputs (attribute `disabled`). */
  disabled: boolean;
  /** Host acknowledgement of a `customizer-save` request. */
  saveResult: SaveResult | null;

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
