import { Service, computed, signal } from '@angular/core';

/**
 * Runtime (not build-time) configuration for cloud persistence. The hosting page provides it on
 * `window.__ZB_PERSONALIZER__`; the standalone application ships no config and therefore defaults to
 * local (IndexedDB) persistence — so the standalone build and behaviour are unchanged.
 *
 * The auth token here is the host's short-lived SESSION token (issued by ZenBasket to the signed-in
 * merchant), supplied at runtime — never a backend secret baked into source. The Worker verifies it.
 */
export interface PersonalizerRuntimeConfig {
  /** Base URL of the Worker API, e.g. `https://api.example.com`. No trailing slash needed. */
  apiBaseUrl?: string;
  /** Host-issued bearer session token. */
  authToken?: string;
  /** Force a mode; otherwise cloud is used when `apiBaseUrl` is set. */
  persistence?: 'local' | 'cloud';
}

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

  readonly apiBaseUrl = computed(() => (this.config().apiBaseUrl ?? '').replace(/\/+$/, ''));
  readonly authToken = computed(() => this.config().authToken ?? null);

  /** Cloud when a base URL is configured and local mode was not explicitly requested. */
  readonly useCloud = computed(() => {
    const c = this.config();
    if (c.persistence === 'local') return false;
    if (c.persistence === 'cloud') return !!this.apiBaseUrl();
    return !!this.apiBaseUrl();
  });

  /** Let the host refresh the session token (e.g. after a silent re-auth) without a reload. */
  setAuthToken(token: string | null): void {
    this.config.update((c) => ({ ...c, authToken: token ?? undefined }));
  }

  update(patch: Partial<PersonalizerRuntimeConfig>): void {
    this.config.update((c) => ({ ...c, ...patch }));
  }
}
