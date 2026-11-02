/**
 * The reference host bridge (integration-demo/extension-bridge.js) and the demo product page built on
 * it. The bridge is GENERIC: these tests drive it with the real personalization element AND with a
 * synthetic extension, to prove it enforces the manifest rather than trusting the extension.
 */
import { readFileSync } from 'node:fs';
import {
  ASSET_PATHS,
  type Environment,
  NESTED,
  host,
  openHost,
  startEnvironment,
  upload,
} from './harness';
import { waitForCrop } from './personalization.helpers';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => env.api.reset());

const mapped = () => {
  const config = JSON.parse(
    readFileSync(new URL('../../public/data/products/tshirt.json', import.meta.url), 'utf8'),
  );
  config.assetBaseUrl = `${env.origin}${NESTED}/assets/`;
  return { body: { data: { personalizable: true, configId: config.id, version: config.version, scope: 'product', config } } };
};

const demoUrl = (product = 'prod-1') =>
  `${env.elementBase}/integration-demo/storefront-cart.html?api=${encodeURIComponent(env.origin)}&store=store-1&product=${product}`;

async function openDemo(product = 'prod-1') {
  const page = await env.browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(demoUrl(product));
  await page.waitForFunction(() => (window as any).testPageReady === true, { timeout: 20000 });
  return page;
}

const addDisabled = (page: import('puppeteer-core').Page) =>
  page.$eval('#add', (b) => (b as HTMLButtonElement).disabled);
const cart = (page: import('puppeteer-core').Page) => page.evaluate(() => (window as any).testCart);

async function makeValid(page: import('puppeteer-core').Page) {
  await page.waitForFunction(
    () => document.querySelector('zb-product-customizer')?.getAttribute('data-status') === 'ready',
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    document.querySelector('zb-product-customizer')!.id = 'a';
  });
  await upload(page, 'a', ASSET_PATHS.samplePhoto);
  await waitForCrop(page, 'a');
  await page.waitForFunction(() => !(document.getElementById('add') as HTMLButtonElement).disabled, { timeout: 20000 });
}

describe('demo product page (generic bridge + personalization element)', () => {
  it('keeps Add to cart disabled until the design is valid, then puts only { customizationId } on the cart line', async () => {
    env.api.responses.set('prod-1', mapped());
    const page = await openDemo();
    await page.waitForFunction(() => (window as any).testBridge.instances().length > 0, { timeout: 20000 });
    expect(await addDisabled(page)).toBe(true);
    expect(await page.$eval('#reason', (e) => e.textContent!.length)).toBeGreaterThan(0);

    await makeValid(page);
    expect(await page.$eval('#reason', (e) => e.textContent)).toBe('');
    await page.click('#add');
    await page.waitForFunction(() => (window as any).testCart.length === 1, { timeout: 30000 });

    const [line] = await cart(page);
    expect(line).toMatchObject({
      productId: 'prod-1',
      quantity: 1,
      lineExtensions: [{ extensionId: 'personalization', key: 'customizationId', value: 'cz-1' }],
    });
    // Nothing else from the extension reaches the cart line (no token, no file ids, no design data).
    expect(JSON.stringify(line)).not.toMatch(/atok|asset-|utok-|front-photo/);
    const preview = JSON.parse(await page.$eval('#event', (e) => e.textContent!));
    expect(preview).toMatchObject({ contract: 1, type: 'order.confirmed', storeId: 'store-1' });
    expect(preview.lines).toEqual([
      expect.objectContaining({ id: 'L1', productId: 'prod-1', extensions: { customizationId: 'cz-1' } }),
    ]);

    // Adding the same design again makes a NEW customization: one customization per cart line.
    await page.click('#add');
    await page.waitForFunction(() => (window as any).testCart.length === 2, { timeout: 30000 });
    expect((await cart(page))[1].lineExtensions[0].value).toBe('cz-2');
    await page.close();
  });

  it('cancels the add with the extension’s shopper-safe message and keeps the page usable', async () => {
    env.api.responses.set('prod-1', mapped());
    env.api.shopper.createAnswer = { status: 429, body: { error: { code: 'rate_limited' } } };
    const page = await openDemo();
    await makeValid(page);
    await page.click('#add');
    await page.waitForFunction(() => document.getElementById('notice')!.textContent!.length > 0, { timeout: 30000 });
    expect(await page.$eval('#notice', (e) => e.textContent)).toMatch(/too many requests/i);
    expect(await cart(page)).toEqual([]);
    expect(await addDisabled(page)).toBe(false); // the shopper can try again
    await page.close();
  });

  it('collapses the slot for a product with no personalization, and adds to cart without extensions', async () => {
    const page = await openDemo('plain-product'); // unmapped
    await page.waitForFunction(() => (window as any).testBridge.instances().some((s: any) => s.ready?.available === false), { timeout: 20000 });
    expect(await page.$eval('zb-product-customizer', (e) => (e as HTMLElement).hidden)).toBe(true);
    await page.waitForFunction(() => !(document.getElementById('add') as HTMLButtonElement).disabled, { timeout: 10000 });
    await page.click('#add');
    await page.waitForFunction(() => (window as any).testCart.length === 1, { timeout: 10000 });
    expect((await cart(page))[0].lineExtensions).toEqual([]);
    expect(env.api.shopper.requests).toHaveLength(0);
    await page.close();
  });
});

/** The bridge's own rules, with a synthetic extension that misbehaves in each way. */
describe('bridge validation', () => {
  const BRIDGE = `${NESTED}/integration-demo/extension-bridge.js`;

  async function scenario(
    page: import('puppeteer-core').Page,
    run: string, // async function body; receives { bridge, announce, define }
  ) {
    return page.evaluate(
      async (bridgeUrl, body) => {
        // A string-built importer: the test runner rewrites a literal `import()` in this function to a
        // runner-internal name that does not exist in the page.
        const { createExtensionBridge } = await new Function('u', 'return import(u)')(bridgeUrl);
        let counter = 0;
        // Defines a fake extension element and returns helpers to speak as it.
        const define = (tag: string, prepare: () => Promise<Record<string, string>>) => {
          if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {});
          const el = document.createElement(tag) as HTMLElement & { prepareForCart: typeof prepare };
          el.prepareForCart = prepare; // per instance: each fake extension answers differently
          document.body.append(el);
          return el;
        };
        const announce = (el: HTMLElement, extensionId: string, type: string, data: unknown = {}, instanceId = `i${++counter}`) =>
          el.dispatchEvent(new CustomEvent('zb:event', { bubbles: true, composed: true, detail: { contract: 1, extensionId, instanceId, slot: 's', type, data, ts: Date.now() } }));
        const fn = new Function('ctx', `return (async () => { ${body} })()`);
        return fn({ createExtensionBridge, define, announce });
      },
      BRIDGE,
      run,
    );
  }

  const manifest = (over: object = {}) =>
    `{ fake: { tag: 'x-fake', permissions: ['cart.line-extensions:write'], lineExtensionKeys: ['ref'], ...${JSON.stringify(over)} } }`;

  it('ignores forged, malformed and unknown events', async () => {
    const { page } = await openHost(env);
    const result = await scenario(
      page,
      `const { createExtensionBridge, define, announce } = ctx;
       const bridge = createExtensionBridge({ manifests: ${manifest()} });
       const good = define('x-fake', async () => ({}));
       const impostor = document.createElement('div'); document.body.append(impostor); // wrong tag for this extension
       announce(impostor, 'fake', 'ready', { available: true });
       announce(good, 'unknown-extension', 'ready', { available: true });
       good.dispatchEvent(new CustomEvent('zb:event', { bubbles: true, composed: true, detail: { contract: 2, extensionId: 'fake', instanceId: 'x', type: 'ready' } }));
       good.dispatchEvent(new CustomEvent('zb:event', { bubbles: true, composed: true, detail: 'nonsense' }));
       const before = bridge.instances().length;
       announce(good, 'fake', 'ready', { available: true });
       return { before, after: bridge.instances().length };`,
    );
    expect(result).toEqual({ before: 0, after: 1 });
    await page.close();
  });

  it('only asks permitted, available instances and passes through the extension’s own rejection message', async () => {
    const { page } = await openHost(env);
    const result = await scenario(
      page,
      `const { createExtensionBridge, define, announce } = ctx;
       let calls = 0;
       const noPerm = createExtensionBridge({ manifests: ${manifest({ permissions: [] })} });
       const el = define('x-fake', async () => { calls++; return { ref: 'v' }; });
       announce(el, 'fake', 'ready', { available: true });
       const withoutPermission = await noPerm.collectLineExtensions();

       const bridge = createExtensionBridge({ manifests: ${manifest()} });
       announce(el, 'fake', 'ready', { available: false }, 'unavailable-one');
       const skipped = await bridge.collectLineExtensions();

       const el2 = define('x-fake', async () => { throw new Error('Please add a photo.'); });
       announce(el2, 'fake', 'ready', { available: true }, 'rejecting-one');
       let message = null;
       try { await bridge.collectLineExtensions(); } catch (e) { message = e.message; }
       return { withoutPermission, skipped, calls, message };`,
    );
    expect(result).toEqual({ withoutPermission: [], skipped: [], calls: 0, message: 'Please add a photo.' });
    await page.close();
  });

  it('refuses keys the manifest does not declare and values over the limits, and returns valid ones', async () => {
    const { page } = await openHost(env);
    const result = await scenario(
      page,
      `const { createExtensionBridge, define, announce } = ctx;
       const bridge = createExtensionBridge({ manifests: ${manifest()} });
       let next = { ref: 'ok-1' };
       const el = define('x-fake', async () => next);
       announce(el, 'fake', 'ready', { available: true });
       const ok = await bridge.collectLineExtensions();
       const attempt = async (values) => { next = values; try { await bridge.collectLineExtensions(); return 'accepted'; } catch (e) { return e.message; } };
       return {
         ok,
         undeclaredKey: await attempt({ ref: 'x', secret: 'y' }),
         tooLong: await attempt({ ref: 'x'.repeat(513) }),
         notAString: await attempt({ ref: 5 }),
         tooMany: await attempt(Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['k' + i, 'v']))),
       };`,
    );
    expect(result.ok).toEqual([{ extensionId: 'fake', key: 'ref', value: 'ok-1' }]);
    expect(result.undeclaredKey).toMatch(/not allowed to attach/);
    expect(result.tooLong).toMatch(/too large/);
    expect(result.notAString).toMatch(/too large/);
    expect(result.tooMany).toMatch(/too much data/);
    await page.close();
  });

  it('blocks Add to cart only while an available instance’s gate is closed, and forgets removed elements', async () => {
    const { page } = await openHost(env);
    const result = await scenario(
      page,
      `const { createExtensionBridge, define, announce } = ctx;
       const bridge = createExtensionBridge({ manifests: ${manifest()} });
       const el = define('x-fake', async () => ({}));
       announce(el, 'fake', 'ready', { available: true }, 'one');
       announce(el, 'fake', 'gate', { allowed: false, reason: 'Add a photo' }, 'one');
       const blocked = [bridge.addToCartBlocked(), bridge.blockedReason()];
       announce(el, 'fake', 'gate', { allowed: true }, 'one');
       const open = bridge.addToCartBlocked();
       announce(el, 'fake', 'gate', { allowed: false, reason: 'x' }, 'one');
       announce(el, 'fake', 'ready', { available: false }, 'one'); // an unavailable extension never blocks
       const unavailable = bridge.addToCartBlocked();
       announce(el, 'fake', 'ready', { available: true }, 'one');
       el.remove();
       return { blocked, open, unavailable, afterRemove: bridge.instances().length };`,
    );
    expect(result).toEqual({ blocked: [true, 'Add a photo'], open: false, unavailable: false, afterRemove: 0 });
    await page.close();
  });

  it('notifies instances when a line is added', async () => {
    const { page } = await openHost(env);
    const result = await scenario(
      page,
      `const { createExtensionBridge, define, announce } = ctx;
       const bridge = createExtensionBridge({ manifests: ${manifest()} });
       const el = define('x-fake', async () => ({}));
       const got = [];
       el.addEventListener('zb:host-event', (e) => got.push(e.detail));
       announce(el, 'fake', 'ready', { available: true });
       bridge.notifyLineAdded({ lineId: 'L9', quantity: 2 });
       return got;`,
    );
    expect(result).toEqual([{ type: 'cart.line-added', data: { lineId: 'L9', quantity: 2 } }]);
    await page.close();
  });
});

void host;
