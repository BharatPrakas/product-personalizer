/**
 * ZenBasket plugin SDK — contract v1.
 *
 * The host (zb-storeadmin) implements this interface in `ZbService` and hands the instance to every
 * plugin element as the DOM property `zbService`. A plugin reads `element.zbService` and codes against
 * the types below, never against Store Admin internals.
 *
 * THIS FILE IS SHARED VERBATIM between the host and the plugin repositories. Keep it free of imports
 * and of Angular/rxjs types: host and plugin run different Angular and rxjs versions, so only
 * Promises and plain data cross the boundary. Change it additively and bump `ZB_SDK_VERSION` when a
 * plugin needs something an older host does not provide.
 */

/** Version of this contract. A plugin may refuse to start on a host that reports a lower number. */
export const ZB_SDK_VERSION = 1;

// ---- authentication -------------------------------------------------------------------------

/** A short-lived bearer token for the plugin's own backend (never the Store Admin session JWT). */
export interface ZbAccessToken {
  token: string;
  /** Epoch milliseconds at which the token stops being valid. Omitted when the host does not know. */
  expiresAt?: number;
}

export interface ZbTokenRequest {
  /**
   * Set after a `401 Unauthorized`: the cached token was rejected, so the host must issue a new one
   * instead of returning the same value again.
   */
  forceRefresh?: boolean;
}

export interface ZbAuthSdk {
  /**
   * Returns an access token for the signed-in merchant's current store. Tokens are short lived, so a
   * plugin calls this before a request and again (with `forceRefresh`) when a request fails with 401.
   * Rejects when the merchant is signed out or no token can be issued.
   */
  getAccessToken(request?: ZbTokenRequest): Promise<ZbAccessToken>;
}

// ---- products -------------------------------------------------------------------------------

export interface ZbProductVariant {
  id: string;
  title: string;
  sku?: string;
}

export interface ZbCollection {
  id: string;
  title: string;
}

/** A product of the signed-in store. Ids are the ZenBasket ids, as strings. */
export interface ZbProduct {
  id: string;
  title: string;
  sku?: string;
  /** Absolute URL. */
  imageUrl?: string;
  variants?: ZbProductVariant[];
  collections?: ZbCollection[];
}

export interface ZbProductQuery {
  /** Free-text search (name, SKU ...). Empty or omitted lists every product. */
  query?: string;
  /** Page size, 1–100. Defaults to 25. */
  limit?: number;
  /** Zero-based offset of the first item. Defaults to 0. */
  offset?: number;
}

export interface ZbProductPage {
  items: ZbProduct[];
  /** Total matches across all pages, when the host knows it. */
  total?: number;
}

export interface ZbProductsSdk {
  /** Searches the signed-in store's catalog (deleted products are never returned). */
  search(query?: ZbProductQuery): Promise<ZbProductPage>;
}

// ---- core services (mirror of AngularCoreAdapter in @zb/shared) ------------------------------

export interface ZbNavigationSdk {
  navigate(url: string, options?: { replace?: boolean }): void;
  back(): void;
}

export interface ZbImageSdk {
  buildUrl(path: string, params?: Record<string, unknown>): string;
}

export interface ZbGraphqlSdk {
  executeQuery(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

export interface ZbStoreSdk {
  getStoreId(): number;
  getLocationId(): number;
  getLanguageCode(): string;
}

export interface ZbCoreSdk {
  navigation: ZbNavigationSdk;
  image: ZbImageSdk;
  graphqlClient: ZbGraphqlSdk;
  store: ZbStoreSdk;
}

// ---- the SDK --------------------------------------------------------------------------------

export interface ZenBasketSdk {
  /** `ZB_SDK_VERSION` of the host that built this object. */
  readonly version: number;
  readonly auth: ZbAuthSdk;
  readonly products: ZbProductsSdk;
  readonly core: ZbCoreSdk;
}
