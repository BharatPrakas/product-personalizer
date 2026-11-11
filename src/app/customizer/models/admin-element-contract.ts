/**
 * Public declaration of the `<zb-personalization-admin>` custom element (the store-admin side):
 * properties, attributes and DOM events. Compiled to `types/admin-element-contract.d.ts` by
 * `npm run build:element`.
 *
 * Trust model: the element never invents products and never trusts the client for the store. The
 * store comes from the verified `authToken` claims on the server; the product list is whatever the
 * host passes in.
 */

export const ADMIN_TAG = 'zb-personalization-admin';

/** What the host tells the element about one of its products. */
export interface ProductRef {
  /** The host's product id. Stored as the `externalId` of a product-scope mapping. */
  id: string;
  sku?: string;
  title: string;
  imageUrl?: string;
  /** Variants of the product, for variant-scope mappings. */
  variants?: ProductVariantRef[];
  /** Collections the product belongs to, for collection-scope mappings. */
  collections?: CollectionRef[];
}

export interface ProductVariantRef {
  id: string;
  title: string;
  sku?: string;
}

export interface CollectionRef {
  id: string;
  title: string;
}

export type MappingScope = 'product' | 'variant' | 'collection';

/** One template-to-product link. Unique per store on `(scope, externalId)`. */
export interface ProductMapping {
  id: string;
  storeId: string;
  /** The template (configuration) id; always the latest published version is served. */
  configId: string;
  scope: MappingScope;
  /** Product id, variant id or collection id, as the host knows it. */
  externalId: string;
  /** Last known display name of the target (product/variant/collection title). */
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The sub-views the element can show; `view` / `config-id` / `order-id` deep-link into them.
 * `orders` lists orders with personalized lines (needs the connected API); with `order-id` it shows one.
 */
export type AdminView = 'list' | 'editor' | 'mapping' | 'preview' | 'orders';

export type AdminPersistence = 'local' | 'cloud';

export type AdminErrorCode =
  | 'auth'
  | 'network'
  | 'conflict'
  | 'invalid'
  | 'not-found'
  | 'storage'
  | 'forbidden'
  | 'rate-limited'
  | 'unexpected';

export interface AdminReadyDetail {
  /** Bundle version. */
  version: string;
  persistence: AdminPersistence;
}

export interface ViewChangeDetail {
  view: AdminView;
  configId: string | null;
  /** The order shown by the `orders` view; `null` for the order list and every other view. */
  orderId: string | null;
}

export interface ConfigSavedDetail {
  configId: string;
  name: string;
  /** Storage-assigned timestamp of the save (ms since epoch). */
  updatedAt: number;
}

export interface ConfigPublishedDetail {
  configId: string;
  name: string;
  /** The template version that is now live. */
  version: number;
  publishedAt: number;
}

export interface ConfigArchivedDetail {
  configId: string;
  name: string;
  /** False when a template is restored from the archive. */
  archived: boolean;
  /** Mappings that still point at the template when it was archived (they stop being served). */
  affectedMappings: number;
}

export interface MappingChangedDetail {
  action: 'created' | 'reassigned' | 'updated' | 'deleted' | 'bulk';
  /** The template the change was made for, when there is a single one. */
  configId: string | null;
  /** Mappings created, moved or updated by this change (empty for pure deletions). */
  mappings: ProductMapping[];
  /** Ids of mappings removed by this change. */
  deletedIds: string[];
}

export interface AdminErrorDetail {
  code: AdminErrorCode;
  /** Sanitised; never contains merchant content (template text, product titles, tokens). */
  message: string;
  recoverable: boolean;
}

/** Event name -> `event.detail` type. Events do not bubble; listen on the element itself. */
export interface ZbPersonalizationAdminEventMap {
  'admin-ready': CustomEvent<AdminReadyDetail>;
  'view-change': CustomEvent<ViewChangeDetail>;
  'config-saved': CustomEvent<ConfigSavedDetail>;
  'config-published': CustomEvent<ConfigPublishedDetail>;
  'config-archived': CustomEvent<ConfigArchivedDetail>;
  'mapping-changed': CustomEvent<MappingChangedDetail>;
  'admin-error': CustomEvent<AdminErrorDetail>;
}

export interface ZbPersonalizationAdminElement extends HTMLElement {
  /** Base URL of the personalization API (attribute `api-base-url`). Enables cloud persistence. */
  apiBaseUrl: string | null;
  /**
   * Short-lived session token issued by the host for the signed-in merchant. Never persisted by
   * the element and re-read on every request, so the host can simply assign a fresh one.
   */
  authToken: string | null;
  /** The host's products for the mapping UI. */
  productCatalog: readonly ProductRef[] | null;
  /**
   * Alternative to `productCatalog` (attribute `product-search-url`): `GET <url>?q=<text>&limit=25`
   * answering `ProductRef[]` or `{ items: ProductRef[] }` (also accepts `{ data: ... }`).
   */
  productSearchUrl: string | null;
  /** Current sub-view (attribute `view`). */
  view: AdminView;
  /** Template shown by the `editor`, `preview` and `mapping` views (attribute `config-id`). */
  configId: string | null;
  /** Order shown by the `orders` view (attribute `order-id`); `null` shows the order list. */
  orderId: string | null;
  /** Hides every control that changes data (attribute `readonly`). */
  readonly: boolean;
  /** BCP-47 language tag for the interface (attribute `locale`). Right-to-left languages mirror the layout. */
  locale: string;
  /** Origins images and fonts of templates may be loaded from, in addition to the element's own. */
  allowedAssetOrigins: readonly string[] | null;
  /** Force local (browser) or cloud persistence; by default cloud is used when `apiBaseUrl` is set. */
  persistence: AdminPersistence | null;

  addEventListener<K extends keyof ZbPersonalizationAdminEventMap>(
    type: K,
    listener: (this: ZbPersonalizationAdminElement, ev: ZbPersonalizationAdminEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof ZbPersonalizationAdminEventMap>(
    type: K,
    listener: (this: ZbPersonalizationAdminElement, ev: ZbPersonalizationAdminEventMap[K]) => unknown,
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
    'zb-personalization-admin': ZbPersonalizationAdminElement;
  }
}
