import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import {
  type Environment,
  NESTED,
  adminHost,
  clickText,
  insideCount,
  insideText,
  openAdminHost,
  startEnvironment,
  upload,
  waitInside,
  writeFixture,
} from './harness';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => env.api.reset());

const CATALOG = [
  {
    id: 'prod-tee',
    sku: 'TEE-1',
    title: 'Classic tee',
    variants: [
      { id: 'tee-s', title: 'Small' },
      { id: 'tee-m', title: 'Medium' },
    ],
    collections: [{ id: 'summer', title: 'Summer' }],
  },
  {
    id: 'prod-mug',
    sku: 'MUG-1',
    title: 'Ceramic mug',
    collections: [{ id: 'kitchen', title: 'Kitchen' }],
  },
  { id: 'prod-cap', sku: 'CAP-1', title: 'Baseball cap' },
];

/** The v2 T-shirt sample as an importable file whose assets resolve next to the element bundle. */
function templateFile(name: string): string {
  const config = JSON.parse(
    readFileSync(new URL('../../public/data/products/tshirt.json', import.meta.url), 'utf8'),
  );
  config.assetBaseUrl = 'assets/';
  config.product.name = name;
  return JSON.stringify(config);
}

const ADMIN = `${NESTED}/store-admin.js`;

async function importTemplate(page: Page, id: string, name: string) {
  const file = writeFixture(env, `${name}.json`, Buffer.from(templateFile(name)));
  await upload(page, id, file);
  await page.waitForFunction(
    (i, n) =>
      [...document.getElementById(i)!.shadowRoot!.querySelectorAll('.row-title')].some((a) =>
        a.textContent!.includes(n),
      ),
    { timeout: 20000 },
    id,
    name,
  );
}

describe('registration and isolation', () => {
  it('registers once, double loading is harmless, and nothing leaks into the host page', async () => {
    const { page } = await openAdminHost(env, { query: '?import=none' });
    const before = await page.evaluate(() => ({
      title: document.title,
      href: location.href,
      history: history.length,
      styles: document.head.querySelectorAll('style, link[rel="stylesheet"]').length,
      globals: Object.getOwnPropertyNames(window),
      defineCalls: 0,
    }));
    await page.evaluate(() => {
      const original = customElements.define.bind(customElements);
      (window as any).defineCalls = 0;
      customElements.define = (
        name: string,
        ctor: CustomElementConstructor,
        options?: ElementDefinitionOptions,
      ) => {
        if (name === 'zb-personalization-admin') (window as any).defineCalls++;
        original(name, ctor, options);
      };
    });
    await page.evaluate(async (base) => {
      await (window as any).adminHost.importAgain(`${base}/store-admin.js`);
      await (window as any).adminHost.importAgain(`${base}/store-admin.js`);
      await (window as any).adminHost.importAgain(`${base}/store-admin.js?v=2`);
    }, NESTED);
    // A second copy of the real registration code (different module URL) must also be a no-op.
    const lazyFile = await page.evaluate(async (base) => {
      const entry = await (await fetch(`${base}/store-admin.js`)).text();
      const mainFile = /from '\.\/(main(?:-[^']+)?\.js)'/.exec(entry)![1];
      const facade = await (await fetch(`${base}/${mainFile}`)).text();
      const target =
        /loadAdmin|function\s+(\w+)\(\)\{return import\(`\.\/(chunk-[^`]+\.js)`\)\.then\(r=>r\.registerPersonalizationAdmin/.exec(
          facade,
        );
      return target ? target[2] : null;
    }, NESTED);
    if (lazyFile) {
      await page.evaluate(async (url) => {
        await (window as any).adminHost.importAgain(url);
      }, `${NESTED}/${lazyFile}?copy=2`);
    }
    await page.evaluate(() => customElements.whenDefined('zb-personalization-admin'));
    expect(await page.evaluate(() => (window as any).defineCalls)).toBe(1);

    await adminHost.mount(page, 'a');
    await adminHost.ready(page, 'a');
    await clickText(page, 'a', 'nav a', 'Product mapping');
    await adminHost.waitView(page, 'a', 'mapping');

    const after = await page.evaluate(() => ({
      title: document.title,
      href: location.href,
      history: history.length,
      styles: document.head.querySelectorAll('style, link[rel="stylesheet"]').length,
      globals: Object.getOwnPropertyNames(window),
    }));
    expect(after.title).toBe(before.title);
    expect(after.href).toBe(before.href); // routing is in memory
    expect(after.history).toBe(before.history);
    expect(after.styles).toBe(before.styles); // every style lives in the shadow root
    expect(after.globals.filter((g) => !before.globals.includes(g) && g !== 'defineCalls')).toEqual(
      [],
    );
    await page.close();
  });

  it('is not affected by hostile host CSS', async () => {
    const { page } = await openAdminHost(env, { query: '?hostile=1' });
    await adminHost.mount(page, 'a');
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', '.app-header');
    const metrics = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const header = root.querySelector('.app-header') as HTMLElement;
      const nav = root.querySelector('nav a') as HTMLElement;
      return {
        headerHeight: header.getBoundingClientRect().height,
        font: getComputedStyle(nav).fontFamily,
        transform: getComputedStyle(nav).textTransform,
        spacing: getComputedStyle(nav).letterSpacing,
      };
    });
    expect(metrics.headerHeight).toBeGreaterThan(40);
    expect(metrics.font).not.toContain('Comic');
    expect(metrics.transform).toBe('none');
    expect(metrics.spacing).toBe('normal');
    await page.close();
  });
});

describe('host contract', () => {
  it('announces itself, reports view changes and follows view / config-id', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a');
    await adminHost.ready(page, 'a');
    const ready = await adminHost.events(page, 'a', 'admin-ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].detail).toMatchObject({ persistence: 'local', version: expect.any(String) });
    expect(ready[0].bubbles).toBe(false);
    expect(await adminHost.view(page, 'a')).toBe('list');

    await clickText(page, 'a', 'nav a', 'Product mapping');
    await adminHost.waitView(page, 'a', 'mapping');
    expect((await adminHost.events(page, 'a', 'view-change')).at(-1)!.detail).toEqual({
      view: 'mapping',
      configId: null,
    });

    await adminHost.set(page, 'a', 'view', 'list');
    await adminHost.waitView(page, 'a', 'list');
    await adminHost.set(page, 'a', 'view', 'bogus');
    await adminHost.waitView(page, 'a', 'list');

    await adminHost.set(page, 'a', 'configId', 'some-id');
    await adminHost.set(page, 'a', 'view', 'editor');
    await adminHost.waitView(page, 'a', 'editor');
    expect(
      await page.evaluate(() => document.getElementById('a')!.getAttribute('data-config-id')),
    ).toBe('some-id');
    await page.close();
  });

  it('shows the host catalog in the mapping view and never invents products', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { view: 'mapping' });
    await adminHost.ready(page, 'a');
    // No published template yet: the view says so instead of listing products.
    await waitInside(page, 'a', 'app-empty-state');
    expect(await insideText(page, 'a', 'app-empty-state')).toContain('no published templates');
    await page.close();
  });

  it('uses the cloud API with the host token, re-reads the token per request, and reports auth failures', async () => {
    env.api.admin.set('GET /api/v1/plugins/personalization/configs', {
      body: {
        data: [],
        meta: { pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
        requestId: 'r',
      },
    });
    env.api.admin.set('GET /api/v1/plugins/personalization/mappings', {
      body: {
        data: [],
        meta: { pagination: { limit: 200, hasMore: false, nextCursor: null } },
        requestId: 'r',
      },
    });
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { apiBaseUrl: env.origin, authToken: 'token-one' });
    await adminHost.ready(page, 'a');
    expect((await adminHost.events(page, 'a', 'admin-ready'))[0].detail.persistence).toBe('cloud');
    await page.waitForFunction(() => true);
    await waitInside(page, 'a', 'app-empty-state');
    const first = env.api.requests.find((r) => r.url.includes('/configs'))!;
    expect(first.headers['authorization']).toBe('Bearer token-one');

    await adminHost.set(page, 'a', 'authToken', 'token-two');
    await clickText(page, 'a', 'nav a', 'Product mapping');
    await adminHost.waitView(page, 'a', 'mapping');
    await page.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 500));
    const later = env.api.requests.filter((r) => r.url.includes('/configs')).at(-1)!;
    expect(later.headers['authorization']).toBe('Bearer token-two');

    env.api.admin.set('GET /api/v1/plugins/personalization/configs', {
      status: 401,
      body: { error: { code: 'unauthorized', message: 'secret-detail' } },
    });
    await clickText(page, 'a', 'nav a', 'Templates');
    await page.waitForFunction(
      () => (window as any).adminHost.events('a', 'admin-error').length > 0,
      { timeout: 10000 },
    );
    const [error] = await adminHost.events(page, 'a', 'admin-error');
    expect(error.detail).toMatchObject({ code: 'auth', recoverable: true });
    expect(JSON.stringify(error.detail)).not.toContain('secret-detail');
    expect(JSON.stringify(error.detail)).not.toContain('token-');
    await page.close();
  });

  it('switches language and mirrors the layout for right-to-left locales', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { locale: 'fr' });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'nav a');
    expect(await insideText(page, 'a', 'nav a')).toBe('Modèles');
    await adminHost.set(page, 'a', 'locale', 'ar-EG');
    await page.waitForFunction(
      () =>
        document
          .getElementById('a')!
          .shadowRoot!.querySelector('.zb-admin')!
          .getAttribute('dir') === 'rtl',
    );
    expect(await insideText(page, 'a', 'nav a')).toBe('القوالب');
    await adminHost.set(page, 'a', 'locale', 'en');
    await page.waitForFunction(
      () =>
        document
          .getElementById('a')!
          .shadowRoot!.querySelector('.zb-admin')!
          .getAttribute('dir') === 'ltr',
    );
    await page.close();
  });
  it('translates the list and the editor chrome for the host locale', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { locale: 'fr' });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', '.page-header');
    const texts = (selector: string) =>
      page.evaluate(
        (s) =>
          [...document.getElementById('a')!.shadowRoot!.querySelectorAll(s)].map((e) =>
            ((e as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').trim(),
          ),
        selector,
      );
    expect(await texts('.page-header .btn')).toEqual(['Importer', 'Nouvelle configuration']);
    await importTemplate(page, 'a', 'Tee français');
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('a.row-title') as HTMLElement
      ).click(),
    );
    await waitInside(page, 'a', '.editor-header');
    const header = await texts('.editor-header .btn');
    expect(header).toEqual(
      expect.arrayContaining(['Aperçu', 'Enregistrer le brouillon', 'Publier']),
    );
    for (const english of ['Preview', 'Save draft', 'Publish', 'Undo', 'Redo']) {
      expect(header).not.toContain(english);
    }
    const labels = await page.evaluate(() =>
      [
        ...document
          .getElementById('a')!
          .shadowRoot!.querySelectorAll('.editor-header [aria-label]'),
      ].map((e) => e.getAttribute('aria-label')),
    );
    expect(labels).toEqual(
      expect.arrayContaining(['Annuler', 'Rétablir', 'Retour aux configurations']),
    );
    expect(await texts('.tabs .tab')).toEqual([
      'Maquettes',
      'Zones',
      'Visuels',
      'Calques',
      'Gabarits',
    ]);
    await page.close();
  });
});
