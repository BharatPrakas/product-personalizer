import { Service, computed, inject } from '@angular/core';
import { AdminHost } from '../admin/admin-host.service';
import type { CollectionRef, ProductRef } from '../customizer/models/admin-element-contract';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import { ZenBasketBridge } from '../zenbasket/zenbasket-bridge';

export const MAX_PRODUCTS = 5000;
const SEARCH_LIMIT = 50;

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/**
 * Host-supplied data is untrusted: keep only well-formed entries and cap sizes so a broken
 * catalog cannot freeze the UI. The element never adds products of its own.
 */
export function normalizeProducts(raw: unknown): ProductRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductRef[] = [];
  for (const item of raw.slice(0, MAX_PRODUCTS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = text(r['id'], 200) ?? (typeof r['id'] === 'number' ? String(r['id']) : undefined);
    const title = text(r['title'], 300);
    if (!id || !title) continue;
    const variants = Array.isArray(r['variants'])
      ? r['variants'].slice(0, 200).flatMap((v: unknown) => {
          const o = (v ?? {}) as Record<string, unknown>;
          const vid =
            text(o['id'], 200) ?? (typeof o['id'] === 'number' ? String(o['id']) : undefined);
          const vt = text(o['title'], 300);
          return vid && vt ? [{ id: vid, title: vt, sku: text(o['sku'], 100) }] : [];
        })
      : undefined;
    const collections = Array.isArray(r['collections'])
      ? r['collections'].slice(0, 100).flatMap((c: unknown) => {
          const o = (c ?? {}) as Record<string, unknown>;
          const cid =
            text(o['id'], 200) ?? (typeof o['id'] === 'number' ? String(o['id']) : undefined);
          const ct = text(o['title'], 300);
          return cid && ct ? [{ id: cid, title: ct }] : [];
        })
      : undefined;
    const imageUrl = text(r['imageUrl'], 2048);
    out.push({
      id,
      title,
      sku: text(r['sku'], 100),
      // Only http(s) images are shown; anything else (javascript:, data:) is dropped.
      imageUrl: imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl : undefined,
      variants,
      collections,
    });
  }
  return out;
}

export function matchesProduct(product: ProductRef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    product.title,
    product.id,
    product.sku,
    ...(product.variants ?? []).flatMap((v) => [v.title, v.sku, v.id]),
    ...(product.collections ?? []).map((c) => c.title),
  ];
  return hay.some((h) => h?.toLowerCase().includes(q));
}

export function collectionsOf(products: readonly ProductRef[]): CollectionRef[] {
  const map = new Map<string, CollectionRef>();
  for (const p of products)
    for (const c of p.collections ?? []) if (!map.has(c.id)) map.set(c.id, c);
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Where the mapping UI gets its products, in order of precedence: the host's `productCatalog`
 * property, its `productSearchUrl` endpoint, then the ZenBasket host SDK (`products.search`).
 */
@Service()
export class ProductCatalog {
  private readonly host = inject(AdminHost);
  private readonly runtime = inject(RuntimeConfig);
  private readonly bridge = inject(ZenBasketBridge);

  readonly source = computed<'catalog' | 'url' | 'sdk' | 'none'>(() => {
    if (this.host.productCatalog()) return 'catalog';
    if (this.host.productSearchUrl()) return 'url';
    return this.bridge.products() ? 'sdk' : 'none';
  });

  /** True when every search is a request to a server (so the UI debounces and shows a spinner). */
  readonly isRemote = computed(() => this.source() === 'url' || this.source() === 'sdk');

  async search(query: string, signal?: AbortSignal): Promise<ProductRef[]> {
    const catalog = this.host.productCatalog();
    if (catalog) return normalizeProducts(catalog).filter((p) => matchesProduct(p, query));
    const base = this.host.productSearchUrl();
    if (!base) return this.searchViaSdk(query);
    const url = new URL(base, document.baseURI);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(SEARCH_LIMIT));
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await this.runtime.ensureToken().catch(() => null);
    // The session token goes only to the personalization API, never to an arbitrary host URL.
    const apiOrigin = this.runtime.apiBaseUrl() ? new URL(this.runtime.apiBaseUrl()).origin : null;
    if (token && apiOrigin && url.origin === apiOrigin)
      headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(url, { headers, credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`product search failed (${response.status})`);
    const body: unknown = await response.json();
    const root = body as Record<string, unknown> | null;
    const list = Array.isArray(body)
      ? body
      : (root?.['items'] ??
        (root?.['data'] as Record<string, unknown> | undefined)?.['items'] ??
        root?.['data']);
    return normalizeProducts(list);
  }

  /** The host SDK's search. A rejected search propagates, so the mapping page shows its retry state. */
  private async searchViaSdk(query: string): Promise<ProductRef[]> {
    const products = this.bridge.products();
    if (!products) return [];
    const page = await products.search({ query: query.trim() || undefined, limit: SEARCH_LIMIT });
    return normalizeProducts(page?.items);
  }
}
