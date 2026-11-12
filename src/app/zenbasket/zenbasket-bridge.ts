import { Service, signal } from '@angular/core';
import type { ZbProductsSdk, ZenBasketSdk } from './zb-sdk';
import type { IssuedToken } from '../workspace/cloud/runtime-config';

/** Oldest host SDK (`ZenBasketSdk.version`) this element works with. */
export const MIN_HOST_SDK_VERSION = 1;

/** Property of the host element the ZenBasket Store Admin assigns its SDK to. */
const SDK_PROPERTY = 'zbService';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Accepts the host's `zbService` only when it has the shape of `ZenBasketSdk` v1+ (a version number
 * and `auth.getAccessToken`). Anything else — no host SDK, a different host, an older SDK — is
 * ignored and the element falls back to the plain properties (`authToken`, `productCatalog` ...).
 */
export function asZenBasketSdk(value: unknown): ZenBasketSdk | null {
  if (!isObject(value)) return null;
  if (typeof value['version'] !== 'number' || value['version'] < MIN_HOST_SDK_VERSION) return null;
  const auth = value['auth'];
  if (!isObject(auth) || typeof auth['getAccessToken'] !== 'function') return null;
  return value as unknown as ZenBasketSdk;
}

/**
 * The element's link to the ZenBasket host SDK (see `zb-sdk.ts`). The Store Admin loader assigns the
 * SDK to the element as `zbService` before attaching it, so it is read once when the element starts.
 * Outside ZenBasket (standalone app, plain HTML host) there is no SDK and every accessor is empty.
 */
@Service()
export class ZenBasketBridge {
  private readonly current = signal<ZenBasketSdk | null>(null);
  private element: HTMLElement | null = null;

  /** The host SDK, or null when the page did not provide a usable one. */
  readonly sdk = this.current.asReadonly();

  /** Binds the bridge to the host element and reads its `zbService`. */
  attach(element: HTMLElement): void {
    const candidate = (element as unknown as Record<string, unknown>)[SDK_PROPERTY];
    const sdk = asZenBasketSdk(candidate);
    if (candidate !== undefined && candidate !== null && !sdk) {
      console.warn(
        `<zb-personalization-admin>: ignoring "${SDK_PROPERTY}"; it is not a ZenBasket SDK v${MIN_HOST_SDK_VERSION}+ object.`,
      );
    }
    this.element = element;
    this.current.set(sdk);
  }

  /**
   * Releases `element`. A no-op when a newer element has attached since: Angular Elements destroys a
   * removed element asynchronously, so its cleanup can run after its replacement has started.
   */
  detach(element: HTMLElement): void {
    if (this.element !== element) return;
    this.element = null;
    this.current.set(null);
  }

  /** The SDK's product access, when the host provides it. */
  products(): ZbProductsSdk | null {
    const products = this.current()?.products;
    return products && typeof products.search === 'function' ? products : null;
  }

  /**
   * Asks the host for an access token (the `TokenProvider` the runtime config uses).
   * @throws When the page has no host SDK or the host cannot issue a token.
   */
  async requestToken(request: { forceRefresh: boolean }): Promise<IssuedToken> {
    const sdk = this.current();
    if (!sdk) throw new Error('No ZenBasket SDK is available.');
    const issued = await sdk.auth.getAccessToken({ forceRefresh: request.forceRefresh });
    return { token: issued.token, expiresAt: issued.expiresAt };
  }
}
