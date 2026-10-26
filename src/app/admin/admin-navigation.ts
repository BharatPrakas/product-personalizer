import type { AdminView } from '../customizer/models/admin-element-contract';

export const ADMIN_VIEWS: readonly AdminView[] = ['list', 'editor', 'mapping', 'preview'];

export function coerceView(value: unknown): AdminView {
  return (ADMIN_VIEWS as readonly unknown[]).includes(value) ? (value as AdminView) : 'list';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** In-memory router URL for a (view, configId) pair; `null` configId means the view's overview. */
export function urlFor(view: AdminView, configId: string | null): string {
  const id = configId && ID.test(configId) ? encodeURIComponent(configId) : null;
  switch (view) {
    case 'editor':
      return id ? `/configurations/${id}` : '/configurations';
    case 'preview':
      return id ? `/preview/${id}` : '/configurations';
    case 'mapping':
      return id ? `/mapping/${id}` : '/mapping';
    default:
      return '/configurations';
  }
}

/** Inverse of `urlFor`. */
export function parseUrl(url: string): { view: AdminView; configId: string | null } {
  const path = url.split(/[?#]/)[0];
  const [first, second] = path.split('/').filter(Boolean);
  const id = second ? decodeURIComponent(second) : null;
  switch (first) {
    case 'configurations':
      return id ? { view: 'editor', configId: id } : { view: 'list', configId: null };
    case 'preview':
      return { view: 'preview', configId: id };
    case 'mapping':
      return { view: 'mapping', configId: id };
    default:
      return { view: 'list', configId: null };
  }
}

/**
 * Internal handshake between the custom-element class (which sees every assignment to `view` /
 * `config-id`, even one equal to the previous value) and the component (which owns the router).
 * Without it, a host that sets `view = 'list'` again after the merchant navigated elsewhere would
 * be ignored, because the input's value did not change.
 */
export const NAVIGATE_HOOK = Symbol.for('zb-personalization-admin.navigate');
