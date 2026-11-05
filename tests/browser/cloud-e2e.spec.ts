/**
 * Optional end-to-end run of BOTH elements against a running `worker-api` (wrangler dev + a local
 * PostgreSQL), driving the real cloud repositories over HTTP. Skipped unless these are set:
 *
 *   ZB_E2E_API_URL    e.g. http://localhost:8787
 *   ZB_E2E_TOKEN      the Worker's DEV_AUTH_TOKEN (.dev.vars)
 *   ZB_E2E_STORE_ID   the Worker's DEV_STORE_ID
 *   ZB_E2E_PORT       a fixed port for the test page server, and that origin
 *                     (http://127.0.0.1:<port>) in the Worker's CORS_ALLOWED_ORIGINS
 *
 * See worker-api/README.md ("End-to-end with the Angular elements").
 */
import { readFileSync } from 'node:fs';
import {
  ASSET_PATHS,
  type Environment,
  adminHost,
  clickText,
  host,
  inside,
  openAdminHost,
  openHost,
  startEnvironment,
  upload,
  waitInside,
  writeFixture,
} from './harness';

const API = process.env['ZB_E2E_API_URL'];
const TOKEN = process.env['ZB_E2E_TOKEN'];
const STORE = process.env['ZB_E2E_STORE_ID'];
const enabled = Boolean(API && TOKEN && STORE && process.env['ZB_E2E_PORT']);

let env: Environment;
beforeAll(async () => {
  if (enabled) env = await startEnvironment();
});
afterAll(async () => {
  await env?.close();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}/api/v1/plugins/personalization${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

describe.skipIf(!enabled)(
  'cloud end to end (admin element -> worker-api -> storefront element)',
  () => {
    it('create, publish and map a template in the admin, then the storefront resolves it', async () => {
      const unique = `E2E ${Date.now()}`;
      const product = `e2e-prod-${Date.now()}`;
      const config = JSON.parse(
        readFileSync(new URL('../../public/data/products/tshirt.json', import.meta.url), 'utf8'),
      );
      config.product.name = unique;
      config.assetBaseUrl = `${env.origin}/nested/path/customizer/assets/`; // absolute: the API serves it as is

      // Allow this page origin to read the public storefront route.
      const origins = await call('PUT', '/settings/storefront', {
        storefrontOrigins: [env.origin],
      });
      expect(origins.status).toBe(200);

      const { page } = await openAdminHost(env);
      await adminHost.mount(page, 'a', {
        apiBaseUrl: API,
        authToken: TOKEN,
        productCatalog: [{ id: product, title: 'E2E tee', sku: 'E2E-1' }],
      });
      await adminHost.ready(page, 'a');
      expect((await adminHost.events(page, 'a', 'admin-ready'))[0].detail.persistence).toBe(
        'cloud',
      );
      await waitInside(page, 'a', 'input[type="file"]');

      await upload(page, 'a', writeFixture(env, 'e2e.json', Buffer.from(JSON.stringify(config))));
      await page.waitForFunction(
        (n) =>
          [...document.getElementById('a')!.shadowRoot!.querySelectorAll('a.row-title')].some((x) =>
            x.textContent!.includes(n),
          ),
        { timeout: 30000 },
        unique,
      );

      // Open + publish.
      await page.evaluate(
        (n) =>
          (
            [...document.getElementById('a')!.shadowRoot!.querySelectorAll('a.row-title')].find(
              (x) => x.textContent!.includes(n),
            ) as HTMLElement
          ).click(),
        unique,
      );
      await adminHost.waitView(page, 'a', 'editor');
      await page.waitForFunction(
        () => {
          const b = [
            ...document.getElementById('a')!.shadowRoot!.querySelectorAll('.editor-header button'),
          ].find((x) => x.textContent!.trim() === 'Publish') as HTMLButtonElement | undefined;
          return !!b && !b.disabled;
        },
        { timeout: 30000 },
      );
      await clickText(page, 'a', '.editor-header button', 'Publish');
      await waitInside(page, 'a', 'app-confirm-host dialog[open]');
      await page.evaluate(() =>
        (
          [
            ...document
              .getElementById('a')!
              .shadowRoot!.querySelectorAll('app-confirm-host dialog[open] button'),
          ].find((b) => b.textContent!.trim() === 'Publish') as HTMLElement
        ).click(),
      );
      await page.waitForFunction(
        () => (window as any).adminHost.events('a', 'config-published').length > 0,
        { timeout: 30000 },
      );
      const published = (await adminHost.events(page, 'a', 'config-published'))[0].detail;
      expect(published.name).toBe(unique);

      // Map it to the product.
      await adminHost.set(page, 'a', 'view', 'mapping');
      await adminHost.set(page, 'a', 'configId', published.configId);
      await waitInside(page, 'a', '.mapping-table tbody tr');
      await page.evaluate(() =>
        (
          document
            .getElementById('a')!
            .shadowRoot!.querySelector(
              '.mapping-table tbody tr input[type="checkbox"]',
            ) as HTMLElement
        ).click(),
      );
      await clickText(page, 'a', '.bulk-bar button', 'Map to this template');
      await page.waitForFunction(
        () => (window as any).adminHost.events('a', 'mapping-changed').length > 0,
        { timeout: 15000 },
      );
      const stored = await call(
        'GET',
        `/mappings?configId=${encodeURIComponent(published.configId)}`,
      );
      expect(stored.body.data.map((m: any) => m.externalId)).toEqual([product]);

      // A markup round-trips through the API.
      const markup = await call('POST', '/markups', {
        name: unique,
        kind: 'area',
        payload: {
          v: 1,
          kind: 'area',
          area: {
            name: 'x',
            canvas: { width: 10, height: 10, background: 'transparent' },
            shape: { type: 'rect' },
          },
        },
      });
      expect(markup.status).toBe(201);
      await call('DELETE', `/markups/${markup.body.data.id}`);

      // The storefront element resolves the mapped template from the public route.
      const shop = await openHost(env);
      await host.mount(shop.page, 's', { productId: product, apiBaseUrl: API, storeId: STORE });
      await host.waitStatus(shop.page, 's', 'ready');
      const ready = await host.events(shop.page, 's', 'customizer-ready');
      expect(ready[0].detail).toMatchObject({
        personalizable: true,
        templateVersion: published.version,
      });

      // Unmapped products stay silent.
      await host.mount(shop.page, 'u', {
        productId: `${product}-other`,
        apiBaseUrl: API,
        storeId: STORE,
      });
      await host.waitStatus(shop.page, 'u', 'not-personalizable');

      // Archive the template: it must stop being served. (The public route is cacheable for a minute,
      // so ask with a fresh query string instead of waiting out the browser cache.)
      await call('POST', `/configs/${encodeURIComponent(published.configId)}/archive`, {});
      await host.mount(shop.page, 'v', {
        productId: product,
        variantId: 'after-archive',
        apiBaseUrl: API,
        storeId: STORE,
      });
      await host.waitStatus(shop.page, 'v', 'not-personalizable');
      await shop.page.close();
      await page.close();
    });

    it('uploads a custom font, adds it to the template, saves, then removes and deletes it', async () => {
      // UI saves are async and the exact "saved" status text/markup is not worth coupling to;
      // poll the Worker itself for the draft to reflect the edit.
      const waitForDraft = async (check: (fonts: Array<{ id: string }>) => boolean, timeoutMs = 20000) => {
        const start = Date.now();
        for (;;) {
          const res = await call('GET', `/configs/${encodeURIComponent(id)}`);
          if (res.status === 200 && check(res.body.data.draft.fonts)) return res.body.data;
          if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the saved draft.');
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      };

      const id = `e2e-font-${Date.now()}`;
      const draft = {
        schemaVersion: 2,
        id,
        version: 1,
        status: 'draft',
        product: { id: `p-${id}`, name: 'Font E2E' },
        assetBaseUrl: `${env.origin}/nested/path/customizer/assets/`,
        variants: [{ id: 'default', label: 'Default', mockupIds: [], printableAreaIds: [] }],
        mockups: [],
        printableAreas: [],
        artworks: [],
        fonts: [{ id: 'sans', family: 'CustomizerSans', label: 'Sans', src: 'fonts/sans-regular.woff2' }],
        fields: [],
      };
      const created = await call('POST', '/configs', { clientConfigId: id, draft });
      expect(created.status).toBe(201);

      const { page } = await openAdminHost(env);
      await adminHost.mount(page, 'a', { apiBaseUrl: API, authToken: TOKEN });
      await adminHost.ready(page, 'a');
      await adminHost.set(page, 'a', 'view', 'editor');
      await adminHost.set(page, 'a', 'configId', id);
      await adminHost.waitView(page, 'a', 'editor');

      await waitInside(page, 'a', 'button[role="tab"]');
      await clickText(page, 'a', 'button[role="tab"]', 'Fonts');
      await waitInside(page, 'a', 'input[type="file"]');
      // The bundled default ('Sans') is listed read-only; no custom font (and no "in template" chip) yet.
      expect(await page.evaluate(() => document.getElementById('a')!.shadowRoot!.querySelector('.chip'))).toBeNull();

      await upload(page, 'a', ASSET_PATHS.fontSample);
      await waitInside(page, 'a', 'button[type="submit"][form="upload-font-form"]');
      await clickText(page, 'a', 'button[type="submit"]', 'Upload font');
      // Uploaded (a store-wide asset, persisted immediately) and auto-added to the open draft.
      await waitInside(page, 'a', '.chip');

      await clickText(page, 'a', '.editor-header button', 'Save draft');
      const saved = await waitForDraft((fonts) => fonts.length === 2);
      const customFont = saved.draft.fonts.find((f: { id: string }) => f.id !== 'sans');
      expect(customFont).toBeTruthy();
      expect(customFont.src).toContain(`${API}/api/v1/storefront/personalization/assets/`);
      expect(customFont.label).toContain('Mono Bold');

      // Remove from the template (a local edit; the library asset itself is untouched) and save again.
      await clickText(page, 'a', '.list-row__actions button', 'Remove from template');
      await clickText(page, 'a', '.editor-header button', 'Save draft');
      await waitForDraft((fonts) => fonts.length === 1);
      expect((await call('GET', `/assets/${customFont.id}`)).status).toBe(200); // still in the library

      // Delete it from the store library: the icon-only "more actions" button has no text to match
      // on, and the selector must stay scoped to the font row (the editor header has its own menu).
      const menuButton = await inside(page, 'a', '.list-row__actions button[aria-haspopup="menu"]');
      await menuButton.click();
      await waitInside(page, 'a', '[role="menuitem"]');
      await clickText(page, 'a', '[role="menuitem"]', 'Delete');
      await waitInside(page, 'a', 'button.btn--danger');
      await clickText(page, 'a', 'button.btn--danger', 'Delete');
      // Poll the Worker (not the row's label text): a label is not unique, so a leftover font of the
      // same name from an earlier run would make a DOM-text wait pass or hang for the wrong reason.
      const start = Date.now();
      let status = 200;
      while (status !== 404) {
        status = (await call('GET', `/assets/${customFont.id}`)).status;
        if (status === 404) break;
        if (Date.now() - start > 20000) throw new Error(`Asset ${customFont.id} was never deleted (last status ${status}).`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(status).toBe(404);

      await page.close();
    });
  },
);
