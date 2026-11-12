import { Service, computed, signal } from '@angular/core';

/**
 * Runtime (not build-time) configuration for cloud persistence. The hosting page provides it on
 * `window.__ZB_PERSONALIZER__`; the standalone application ships no config and therefore defaults to
 * local (IndexedDB) persistence — so the standalone build and behaviour are unchanged.
 *
 * The auth token here is the host's short-lived SESSION token (issued by ZenBasket to the signed-in
 * merchant), supplied at runtime — never a backend secret baked into source. The Worker verifies it.
 * Inside ZenBasket Store Admin the token comes from the host SDK (`ZenBasketSdk.auth`) through a
 * {@link TokenProvider}, so it can be renewed when it expires or the API answers 401.
 */
export interface PersonalizerRuntimeConfig {
  /** Base URL of the Worker API, e.g. `https://api.example.com`. No trailing slash needed. */
  apiBaseUrl?: string;
  /** Host-issued bearer session token. */
  authToken?: string;
  /** Force a mode; otherwise cloud is used when `apiBaseUrl` is set. */
  persistence?: 'local' | 'cloud';
}

/** A token handed out by a {@link TokenProvider}. */
export interface IssuedToken {
  token: string;
  /** Epoch milliseconds at which the token stops being valid; unknown when absent. */
  expiresAt?: number;
}

/** Fetches a token from the host. `forceRefresh` is true after the API rejected the previous one. */
export type TokenProvider = (request: { forceRefresh: boolean }) => Promise<IssuedToken>;

/** A token this close to its expiry is renewed before the next request instead of after a 401. */
const EXPIRY_SKEW_MS = 30_000;

declare global {
  interface Window {
    __ZB_PERSONALIZER__?: PersonalizerRuntimeConfig;
  }
}

function readInitial(): PersonalizerRuntimeConfig {
  if (typeof window === 'undefined') return {};
  const raw = window.__ZB_PERSONALIZER__;
  return raw && typeof raw === 'object' ? { ...raw } : {};
}

@Service()
export class RuntimeConfig {
  private readonly config = signal<PersonalizerRuntimeConfig>(readInitial());
  /** The token most recently obtained from the provider; wins over `config.authToken`. */
  private readonly issued = signal<IssuedToken | null>(null);
  private provider: TokenProvider | null = null;
  private refreshing: Promise<boolean> | null = null;

  readonly apiBaseUrl = computed(() => (this.config().apiBaseUrl ?? '').replace(/\/+$/, ''));
  readonly authToken = computed(() => this.issued()?.token ?? this.config().authToken ?? null);

  /** Cloud when a base URL is configured and local mode was not explicitly requested. */
  readonly useCloud = computed(() => {
    const c = this.config();
    if (c.persistence === 'local') return false;
    if (c.persistence === 'cloud') return !!this.apiBaseUrl();
    return !!this.apiBaseUrl();
  });

  /** Let the host refresh the session token (e.g. after a silent re-auth) without a reload. */
  setAuthToken(token: string | null): void {
    this.update({ authToken: token ?? undefined });
  }

  update(patch: Partial<PersonalizerRuntimeConfig>): void {
    this.config.update((c) => ({ ...c, ...patch }));
    // A token the host assigns explicitly replaces whatever the provider issued earlier.
    if (patch.authToken) this.issued.set(null);
  }

  /** Installs the function that obtains tokens from the host. */
  setTokenProvider(provider: TokenProvider): void {
    this.provider = provider;
    this.issued.set(null);
  }

  /** Removes `provider`, unless another one was installed since (see `ZenBasketBridge.detach`). */
  clearTokenProvider(provider: TokenProvider): void {
    if (this.provider !== provider) return;
    this.provider = null;
    this.issued.set(null);
  }

  /**
   * The token to send now. Uses the current one while it is valid; otherwise (none yet, or about to
   * expire) asks the provider. Without a provider this is just the configured token.
   * @throws When the provider is needed and fails.
   */
  async ensureToken(): Promise<string | null> {
    const current = this.authToken();
    if (current && !this.expiring()) return current;
    if (!this.provider) return current;
    if (!(await this.fetchToken(false))) throw new Error('The session token could not be obtained.');
    return this.authToken();
  }

  /**
   * Asks the provider for a new token after the API rejected the current one (401). Concurrent
   * callers share one provider call. Resolves false when there is no provider or it failed.
   */
  refreshToken(): Promise<boolean> {
    return this.provider ? this.fetchToken(true) : Promise.resolve(false);
  }

  private expiring(): boolean {
    const expiresAt = this.issued()?.expiresAt;
    return expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS <= Date.now();
  }

  private fetchToken(forceRefresh: boolean): Promise<boolean> {
    const provider = this.provider;
    if (!provider) return Promise.resolve(false);
    this.refreshing ??= (async () => {
      try {
        const issued = await provider({ forceRefresh });
        if (!issued || typeof issued.token !== 'string' || !issued.token) return false;
        const expiresAt = Number.isFinite(issued.expiresAt) ? issued.expiresAt : undefined;
        this.issued.set({ token: issued.token, expiresAt });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
