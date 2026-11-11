import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { type Environment, adminHost, clickText, openAdminHost, startEnvironment, waitInside } from './harness';

/**
 * The Orders view against a scripted personalization API: list -> detail -> downloads, with AXE on
 * every state. The order webhook dispatcher does not exist yet, so the API answers are fixtures in
 * the shape the Worker returns (worker-api/src/modules/personalization/order-service.ts).
 */

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ADMIN = '/api/v1/plugins/personalization';
const TOKEN = 'merchant-session-token';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => env.api.reset());

async function axeViolations(page: Page, id: string): Promise<string[]> {
  // Colour checks sample computed styles: let button transitions (disabled -> enabled) finish first.
  await page.waitForFunction((i) => document.getElementById(i)!.shadowRoot!.getAnimations().length === 0, {}, id);
  await page.evaluate(axeSource);
  const result = (await page.evaluate(
    (i) =>
      (window as any).axe.run(document.getElementById(i), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { region: { enabled: false } },
      }),
    id,
  )) as { violations: { id: string; nodes: { target: unknown[] }[] }[] };
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

const CONFIG = {
  schemaVersion: 2, id: 'cfg-mug', version: 3, status: 'published', product: { id: 'p', name: 'Mug' },
  variants: [{ id: 'v1', label: 'White', mockupIds: ['m1'], printableAreaIds: ['a1'] }],
  mockups: [{ id: 'm1', name: 'Front view', src: 'x', placements: [] }],
  printableAreas: [
    { id: 'a1', name: 'Wrap', enabled: true, canvas: { width: 2000, height: 800 }, shape: { type: 'rect' }, artworkId: 'art1', artworkIds: ['art1'] },
    { id: 'a2', name: 'Handle', enabled: true, canvas: { width: 200, height: 200 }, shape: { type: 'rect' }, artworkId: 'art1', artworkIds: ['art1'] },
  ],
  artworks: [{ id: 'art1', name: 'Photo wrap', printableAreaId: 'a1', layers: [] }],
  fonts: [{ id: 'f1', family: 'Inter', src: 'x' }],
  fields: [
    { id: 'name', type: 'text', label: 'Your name', required: true, maxLength: 20, fontIds: ['f1'], colors: ['#112233'] },
    { id: 'photo', type: 'image', label: 'Your photo', required: true },
  ],
};

const asset = (assetId: string, kind: string, filename: string, contentType = 'image/png') => ({
  assetId, kind, contentType, sizeBytes: PNG.length, width: 1, height: 1, filename,
});

function script(api: Environment['api']) {
  api.admin.set(`GET ${ADMIN}/configs`, { body: { data: [], meta: { pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } } } });
  api.admin.set(`GET ${ADMIN}/orders`, {
    body: {
      data: [{
        orderId: 'ORD-1001', orderNumber: '#1001', placedAt: '2026-11-01T10:00:00.000Z', customerName: 'Zelda Quill',
        linkedAt: '2026-11-01T10:05:00.000Z', lineCount: 1,
        lines: [{ lineId: 'L-1', productId: 'p', title: 'Photo mug', quantity: 2, status: 'ordered', customizationId: 'cz-1', previewAssetId: 'pre-1' }],
      }],
      meta: { pagination: { limit: 25, hasMore: false, nextCursor: null } },
    },
  });
  api.admin.set(`GET ${ADMIN}/orders/ORD-1001`, {
    body: {
      data: {
        orderId: 'ORD-1001', orderNumber: '#1001', placedAt: '2026-11-01T10:00:00.000Z', currency: 'EUR',
        totals: { subtotal: '40.00', shipping: null, tax: null, discount: null, total: '40.00' },
        customer: { id: null, name: 'Zelda Quill', email: 'zelda@example.test', phone: null },
        shippingAddress: { name: 'Zelda Quill', line1: '1 Road', line2: null, city: 'Lyon', region: null, postalCode: '69001', country: 'FR', phone: null },
        billingAddress: null,
        linkedAt: '2026-11-01T10:05:00.000Z',
        lines: [{
          lineId: 'L-1', productId: 'p', variantId: 'v1', quantity: 2, title: 'Photo mug', sku: 'MUG-1', unitPrice: '20.00',
          linkedAt: '2026-11-01T10:05:00.000Z',
          customization: { id: 'cz-1', status: 'ordered', configId: 'cfg-mug', configVersion: 3 },
          assets: [asset('art-1', 'artwork', 'a1'), asset('pre-1', 'preview', 'm1'), asset('up-1', 'upload', 'local-1', 'image/jpeg')],
        }],
      },
    },
  });
  api.admin.set(`GET ${ADMIN}/customizations/cz-1`, {
    body: {
      data: {
        id: 'cz-1', status: 'ordered', configId: 'cfg-mug', configVersion: 3, productId: 'p', variantId: 'v1', createdAt: 0,
        orderedAt: '2026-11-01T10:05:00.000Z',
        data: {
          schema: 1,
          template: { id: 'cfg-mug', version: 3 },
          customization: {
            schemaVersion: 2, productId: 'p', configId: 'cfg-mug', configVersion: 3, variantId: 'v1',
            artworkSelection: { a1: 'art1' },
            values: { name: { text: 'Ada', fontId: 'f1', color: '#112233' }, photo: { assetId: 'local-1', crop: [0, 0, 1, 1] } },
            areas: {},
          },
          files: {
            uploads: [{ assetId: 'local-1', ref: 'up-1' }],
            // `a2`'s artwork is referenced but no longer stored.
            artworks: [{ printableAreaId: 'a1', ref: 'art-1', width: 1, height: 1 }, { printableAreaId: 'a2', ref: 'art-gone', width: 200, height: 200 }],
            previews: [{ mockupId: 'm1', ref: 'pre-1' }],
          },
        },
      },
    },
  });
  api.admin.set(`GET ${ADMIN}/configs/cfg-mug/versions`, { body: { data: [{ versionId: 'ver-3', version: 3, createdAt: 0 }] } });
  api.admin.set(`GET ${ADMIN}/configs/cfg-mug/versions/ver-3`, { body: { data: { versionId: 'ver-3', version: 3, createdAt: 0, snapshot: CONFIG } } });
  for (const id of ['art-1', 'pre-1', 'up-1']) {
    api.admin.set(`GET ${ADMIN}/customizations/cz-1/assets/${id}/content`, { bytes: PNG, contentType: id === 'up-1' ? 'image/jpeg' : 'image/png' });
  }
}

/** Captures `downloadBlob` (a temporary `<a download>` click) as { name, bytes } in the page. */
async function captureDownloads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (!this.download) return click.call(this);
      const name = this.download;
      w.__downloads.push(fetch(this.href).then((r) => r.arrayBuffer()).then((b) => ({ name, bytes: [...new Uint8Array(b)] })));
    };
  });
}

const downloads = (page: Page) =>
  page.evaluate(() => Promise.all((window as any).__downloads)) as Promise<{ name: string; bytes: number[] }[]>;

/** Entry names of a ZIP (central directory). */
function zipNames(bytes: number[]): string[] {
  const buf = Buffer.from(bytes);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  let pos = buf.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const length = buf.readUInt16LE(pos + 28);
    names.push(buf.subarray(pos + 46, pos + 46 + length).toString('utf8'));
    pos += 46 + length;
  }
  return names;
}

const text = (page: Page, selector: string) =>
  page.evaluate((s) => document.getElementById('a')!.shadowRoot!.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? '', selector);

describe('admin Orders view', () => {
  it('lists orders, opens one, shows the customer’s inputs and downloads files and ZIPs (AXE clean)', async () => {
    script(env.api);
    const { page } = await openAdminHost(env);
    await captureDownloads(page);
    await adminHost.mount(page, 'a', { apiBaseUrl: env.origin, authToken: TOKEN, view: 'orders' });
    await adminHost.ready(page, 'a');
    await adminHost.waitView(page, 'a', 'orders');

    // List
    await waitInside(page, 'a', '.orders-table');
    expect(await text(page, '.orders-table tbody tr')).toContain('#1001');
    await waitInside(page, 'a', '.orders-table app-auth-image img');
    expect(await axeViolations(page, 'a')).toEqual([]);

    // List -> detail
    await clickText(page, 'a', '.orders-table a', '#1001');
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-order-id') === 'ORD-1001', { timeout: 20000 });
    const viewChange = (await adminHost.events(page, 'a', 'view-change')).at(-1)!.detail;
    expect(viewChange).toEqual({ view: 'orders', configId: null, orderId: 'ORD-1001' });
    await waitInside(page, 'a', '.line-card__files');
    const card = await text(page, 'app-order-line-card');
    expect(card).toContain('Your name'); // label from the pinned template version
    expect(card).toContain('Ada');
    expect(card).toContain('Photo wrap');
    expect(card).toContain('File unavailable'); // the referenced-but-gone artwork
    expect(await text(page, '.order-detail__summary')).toContain('zelda@example.test');
    await waitInside(page, 'a', '.line-card__gallery app-auth-image img');
    expect(await axeViolations(page, 'a')).toEqual([]);

    // Lightbox: a modal dialog, keyboard-closable.
    await page.evaluate(() => (document.getElementById('a')!.shadowRoot!.querySelector('.line-card__thumb') as HTMLElement).click());
    await waitInside(page, 'a', 'app-order-line-card dialog[open] app-auth-image img');
    expect(await axeViolations(page, 'a')).toEqual([]);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('a')!.shadowRoot!.querySelector('dialog[open]'));

    // One file.
    await clickText(page, 'a', '.line-card__file button', 'Download Wrap');
    // "Download all" for the line: the preview fails once, is reported, and only it is retried.
    env.api.admin.set(`GET ${ADMIN}/customizations/cz-1/assets/pre-1/content`, { status: 500, body: { error: { code: 'boom' } } });
    await clickText(page, 'a', '.line-card__head button', 'Download all Photo mug');
    await page.waitForFunction(
      () => /could not be downloaded/.test(document.getElementById('a')!.shadowRoot!.querySelector('.download-status')!.textContent!),
      { timeout: 20000 },
    );
    const status = await text(page, '.download-status');
    expect(status).toContain('production/Handle.png');
    expect(status).toContain('previews/Front view.png');
    expect(await axeViolations(page, 'a')).toEqual([]);
    const before = env.api.requests.length;
    env.api.admin.set(`GET ${ADMIN}/customizations/cz-1/assets/pre-1/content`, { bytes: PNG, contentType: 'image/png' });
    await clickText(page, 'a', '.download-status button', 'Retry failed files');
    // Two failures before (the gone file + the 500); only the gone one is left after the retry.
    await page.waitForFunction(
      () => /(^|\s)1 files of .* could not be downloaded/.test(document.getElementById('a')!.shadowRoot!.querySelector('.download-status')!.textContent!),
      { timeout: 20000 },
    );
    const retried = env.api.requests.slice(before).map((r) => r.url);
    expect(retried.filter((u) => u.includes('/content'))).toEqual([`${ADMIN}/customizations/cz-1/assets/pre-1/content`]);
    // Only the gone file is left: save without it.
    await clickText(page, 'a', '.download-status button', 'Save without them');
    await page.waitForFunction(() => /downloaded without 1 files/.test(document.getElementById('a')!.shadowRoot!.querySelector('.download-status')!.textContent!));

    // Whole order.
    await clickText(page, 'a', '.download-status button', 'Dismiss');
    await clickText(page, 'a', '.page-header button', 'Download order');
    // The gone file is reported before anything is saved; the merchant chooses to go on without it.
    await page.waitForFunction(
      () => /1 files of order-ORD-1001\.zip could not be downloaded/.test(document.getElementById('a')!.shadowRoot!.querySelector('.download-status')!.textContent!),
      { timeout: 20000 },
    );
    await clickText(page, 'a', '.download-status button', 'Save without them');
    await page.waitForFunction(() => (window as any).__downloads.length >= 3, { timeout: 20000 });

    const files = await downloads(page);
    expect(files.map((f) => f.name)).toEqual([
      'order-ORD-1001-line-L-1-production-Wrap.png',
      'order-ORD-1001-line-L-1.zip',
      'order-ORD-1001.zip',
    ]);
    expect(Buffer.from(files[0].bytes).equals(PNG)).toBe(true);
    expect(zipNames(files[1].bytes)).toEqual([
      'production/Wrap.png', 'previews/Front view.png', 'uploads/Your photo.jpg', 'customization.json',
    ]);
    expect(zipNames(files[2].bytes)).toEqual([
      'line-L-1/production/Wrap.png', 'line-L-1/previews/Front view.png', 'line-L-1/uploads/Your photo.jpg', 'line-L-1/customization.json',
    ]);

    // Every call carried the token in the header; none put it in a URL.
    const calls = env.api.requests.filter((r) => r.url.startsWith(ADMIN));
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
    }
    // Customer data never reaches the host through events.
    expect(JSON.stringify(await adminHost.events(page, 'a'))).not.toMatch(/Zelda|zelda@|1 Road/);
    await page.close();
  });

  it('shows a not-found state for an unknown order and the connected-backend notice in local mode (AXE clean)', async () => {
    script(env.api);
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { apiBaseUrl: env.origin, authToken: TOKEN, view: 'orders', orderId: 'NOPE' });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'app-order-detail app-empty-state');
    expect(await text(page, 'app-order-detail')).toContain('That order was not found');
    expect(await axeViolations(page, 'a')).toEqual([]);
    await page.close();

    // No API: the browser-only workspace has no orders and says why.
    const local = (await openAdminHost(env)).page;
    await adminHost.mount(local, 'b', { view: 'orders' });
    await adminHost.ready(local, 'b');
    await waitInside(local, 'b', 'app-orders-page app-empty-state');
    expect(
      await local.evaluate(() => document.getElementById('b')!.shadowRoot!.querySelector('app-orders-page')!.textContent),
    ).toContain('Orders need the connected backend');
    expect(await axeViolations(local, 'b')).toEqual([]);
    expect(env.api.requests.filter((r) => r.url.includes('/orders'))).toHaveLength(1); // only the NOPE lookup
    await local.close();
  });
});
