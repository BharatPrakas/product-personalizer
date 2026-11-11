import type { AdminView } from '../customizer/models/admin-element-contract';

export const ADMIN_VIEWS: readonly AdminView[] = ['list', 'editor', 'mapping', 'preview', 'orders'];

export function coerceView(value: unknown): AdminView {
  return (ADMIN_VIEWS as readonly unknown[]).includes(value) ? (value as AdminView) : 'list';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Order ids are the platform's own strings: anything printable up to 200 characters, always encoded. */
const ORDER_ID = /^[^\u0000-\u001f\u007f]{1,200}$/;

export interface AdminLocation {
  view: AdminView;
  configId: string | null;
  orderId: string | null;
}

/**
 * In-memory router URL for a view and its id; a `null` id means the view's overview. `configId`
 * selects the template of `editor` / `preview` / `mapping`, `orderId` the order of `orders`.
 */
export function urlFor(view: AdminView, configId: string | null, orderId: string | null = null): string {
  const id = configId && ID.test(configId) ? encodeURIComponent(configId) : null;
  switch (view) {
    case 'orders':
      return orderId && ORDER_ID.test(orderId) && orderId.trim()
        ? `/orders/${encodeURIComponent(orderId)}`
        : '/orders';
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
export function parseUrl(url: string): AdminLocation {
  const path = url.split(/[?#]/)[0];
  const [first, second] = path.split('/').filter(Boolean);
  let id: string | null = null;
  try {
    id = second ? decodeURIComponent(second) : null;
  } catch {
    id = null; // malformed escape: treat as the overview
  }
  switch (first) {
    case 'configurations':
      return id
        ? { view: 'editor', configId: id, orderId: null }
        : { view: 'list', configId: null, orderId: null };
    case 'preview':
      return { view: 'preview', configId: id, orderId: null };
    case 'mapping':
      return { view: 'mapping', configId: id, orderId: null };
    case 'orders':
      return { view: 'orders', configId: null, orderId: id };
    default:
      return { view: 'list', configId: null, orderId: null };
  }
}

/**
 * Internal handshake between the custom-element class (which sees every assignment to `view` /
 * `config-id`, even one equal to the previous value) and the component (which owns the router).
 * Without it, a host that sets `view = 'list'` again after the merchant navigated elsewhere would
 * be ignored, because the input's value did not change.
 */
export const NAVIGATE_HOOK = Symbol.for('zb-personalization-admin.navigate');
