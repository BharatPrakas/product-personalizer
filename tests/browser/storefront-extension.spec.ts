/**
 * Extension Platform Contract v1, element side (docs/extension-platform-contract-v1.md, sections 4–6):
 * the `zb:event` envelope, `prepareForCart()` and how it talks to the personalization API. The API is a
 * scriptable stand-in served from the page origin; `cloud-e2e.spec.ts` covers the real Worker.
 */
import { readFileSync } from 'node:fs';
import {
  ASSET_PATHS,
  type Environment,
  NESTED,
  host,
  insideCount,
  openHost,
  startEnvironment,
  typeText,
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

const tshirt = () => {
  const config = JSON.parse(
    readFileSync(new URL('../../public/data/products/tshirt.json', import.meta.url), 'utf8'),
  );
  config.assetBaseUrl = `${env.origin}${NESTED}/assets/`;
  return config;
};

const mapped = () => {
  const config = tshirt();
  return { body: { data: { personalizable: true, configId: config.id, version: config.version, scope: 'product', config } } };
};

const props = () => ({ productId: 'prod-1', apiBaseUrl: env.origin, storeId: 'store-1' });

/** Gives the shopper a valid design (a photo is the only required field left). */
async function makeValid(page: import('puppeteer-core').Page, id: string): Promise<void> {
  await upload(page, id, ASSET_PATHS.samplePhoto);
  await waitForCrop(page, id);
  await page.waitForFunction(
    (i) => (window as any).testHost.zb.some((e: any) => e.targetId === i && e.type === 'gate' && e.data.allowed),
    { timeout: 20000 },
    id,
  );
}

const uploads = () => env.api.shopper.requests.filter((r) => r.endpoint === 'uploads');
const creates = () => env.api.shopper.requests.filter((r) => r.endpoint === 'customizations');

describe('zb:event envelope', () => {
  it('bubbles to the document with contract, extension id, instance id, slot and timestamp', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(), { attributes: { 'instance-id': 'inst-42' } });
    await host.waitStatus(page, 'a', 'ready');
    await page.waitForFunction(() => (window as any).testHost.zb.some((e: any) => e.type === 'rendered'), { timeout: 20000 });

    const events = await host.zbEvents(page);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e).toMatchObject({
        contract: 1,
        extensionId: 'personalization',
        instanceId: 'inst-42',
        slot: 'storefront.product.detail.block',
        targetId: 'a',
        bubbles: true,
        composed: true,
      });
      expect(typeof e.ts).toBe('number');
    }
    expect(events.filter((e) => e.type === 'ready').map((e) => e.data)).toEqual([{ available: true }]);
    expect(events.filter((e) => e.type === 'rendered')).toHaveLength(1); // once per instance
    // Contract events arrive IN ADDITION to the original, element-local `customizer-*` events.
    expect(await host.events(page, 'a', 'customizer-ready')).toHaveLength(1);
    await page.close();
  });

  it('generates a stable instance id per element when the host assigns none', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.mount(page, 'b', props());
    await host.waitStatus(page, 'a', 'ready');
    await host.waitStatus(page, 'b', 'ready');
    const events = await host.zbEvents(page);
    const idsOf = (target: string) => new Set(events.filter((e) => e.targetId === target).map((e) => e.instanceId));
    expect(idsOf('a').size).toBe(1);
    expect(idsOf('b').size).toBe(1);
    expect([...idsOf('a')][0]).not.toBe([...idsOf('b')][0]);
    await page.close();
  });

  it('gates Add to cart until the design is valid, and never repeats an unchanged gate', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');

    const gates = (await host.zbEvents(page)).filter((e) => e.type === 'gate').map((e) => e.data);
    expect(gates[0].allowed).toBe(false);
    expect(typeof gates[0].reason).toBe('string');
    expect(gates.at(-1)).toEqual({ allowed: true });
    // No two consecutive identical gates.
    gates.forEach((g, i) => i > 0 && expect(JSON.stringify(g)).not.toBe(JSON.stringify(gates[i - 1])));
    await page.close();
  });

  it('reports an unmapped product as unavailable: slot collapses, nothing to gate, nothing rendered', async () => {
    const { page } = await openHost(env); // no mapping -> { personalizable: false }
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'not-personalizable');
    const events = await host.zbEvents(page);
    expect(events.filter((e) => e.type === 'ready').map((e) => e.data)).toEqual([{ available: false }]);
    // Disabled only while the template is being looked up, then open: there is nothing to personalize.
    const gates = events.filter((e) => e.type === 'gate').map((e) => e.data);
    expect(gates.at(-1)).toEqual({ allowed: true });
    expect(gates.slice(0, -1).every((g) => g.allowed === false)).toBe(true);
    expect(events.some((e) => e.type === 'rendered')).toBe(false);
    // The host may still call it; there is simply nothing to attach, and nothing is saved.
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: {} });
    expect(env.api.shopper.requests).toHaveLength(0);
    await page.close();
  });

  it('`error` carries a code and recoverability only — never a message', async () => {
    env.api.responses.set('prod-1', { status: 500, body: { error: { code: 'internal_error', message: 'secret detail' } } });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await page.waitForFunction(() => (window as any).testHost.zb.some((e: any) => e.type === 'error'), { timeout: 20000 });
    const errors = (await host.zbEvents(page)).filter((e) => e.type === 'error');
    expect(errors[0].data).toEqual({ code: expect.any(String), recoverable: expect.any(Boolean) });
    expect(JSON.stringify(errors)).not.toContain('secret detail');
    // A personalizable product whose personalization cannot load must not be added un-personalized.
    const gate = (await host.zbEvents(page)).filter((e) => e.type === 'gate').at(-1)!;
    expect(gate.data.allowed).toBe(false);
    await page.close();
  });
});

describe('hide-save', () => {
  it('removes the element’s own Save button (the host’s Add to cart is the primary action)', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(), { attributes: { 'hide-save': '' } });
    await host.mount(page, 'b', props());
    await host.waitStatus(page, 'a', 'ready');
    await host.waitStatus(page, 'b', 'ready');
    expect(await insideCount(page, 'a', 'button.primary')).toBe(0);
    expect(await insideCount(page, 'b', 'button.primary')).toBe(1);
    await page.close();
  });
});

describe('prepareForCart()', () => {
  it('saves the design (uploads first, then the customization) and resolves { customizationId }', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(), variantId: 'white', collectionIds: ['summer'] });
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');

    const result = await host.prepare(page, 'a');
    expect(result).toEqual({ ok: true, value: { customizationId: 'cz-1' } });

    // Order: every file is uploaded before the customization that references them.
    const order = env.api.shopper.requests.map((r) => r.endpoint);
    expect(order.at(-1)).toBe('customizations');
    expect(order.slice(0, -1).every((e) => e === 'uploads')).toBe(true);
    const kinds = uploads().map((u) => u.query['kind']);
    expect(kinds).toContain('upload'); // the shopper's photo
    expect(kinds).toContain('artwork'); // print-ready file per printable area
    expect(kinds).toContain('preview'); // composite preview
    for (const u of uploads()) {
      expect(u.query['storeId']).toBe('store-1');
      expect(u.bodySize).toBeGreaterThan(0);
      expect(u.contentType).toMatch(/^image\//);
    }

    const [create] = creates();
    expect(create.query['storeId']).toBe('store-1');
    expect(create.json).toMatchObject({
      productId: 'prod-1',
      variantId: 'white',
      collectionIds: ['summer'],
      configId: 'tshirt-personalization',
      configVersion: 1,
    });
    // Every upload is attached with the token it was issued.
    expect(create.json.assets).toEqual(uploads().map((_, i) => ({ assetId: `asset-${i + 1}`, uploadToken: `utok-${i + 1}` })));
    // The data says which stored file is which, so a merchant can fulfil the order.
    const files = create.json.data.files;
    expect(files.uploads).toHaveLength(kinds.filter((k) => k === 'upload').length);
    expect(files.artworks).toHaveLength(kinds.filter((k) => k === 'artwork').length);
    expect(files.previews).toHaveLength(kinds.filter((k) => k === 'preview').length);
    const refs = [...files.uploads, ...files.artworks, ...files.previews].map((f: any) => f.ref).sort();
    expect(refs).toEqual(create.json.assets.map((a: any) => a.assetId).sort());
    expect(create.json.data.customization.values['front-photo'].assetId).toBe(files.uploads[0].assetId);
    // The access token is NOT handed to the host (only the id goes onto the cart).
    expect(JSON.stringify(result)).not.toContain('atok');

    const saved = (await host.zbEvents(page)).filter((e) => e.type === 'personalization.saved');
    expect(saved).toHaveLength(1);
    expect(saved[0].data).toEqual({ customizationId: 'cz-1', templateId: 'tshirt-personalization', templateVersion: 1 });
    await page.close();
  });

  it('shares one save between concurrent calls and reuses it for the same design', async () => {
    env.api.responses.set('prod-1', mapped());
    env.api.shopper.createDelayMs = 300;
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');

    const [first, second] = await Promise.all([host.prepare(page, 'a'), host.prepare(page, 'a')]);
    expect(first).toEqual({ ok: true, value: { customizationId: 'cz-1' } });
    expect(second).toEqual(first);
    expect(creates()).toHaveLength(1);

    const requestsAfterFirst = env.api.shopper.requests.length;
    expect(await host.prepare(page, 'a')).toEqual(first); // unchanged design: no new save
    expect(env.api.shopper.requests).toHaveLength(requestsAfterFirst);
    await page.close();
  });

  it('saves a NEW customization after the host reports the line added (one customization, one order line)', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');

    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-1' } });
    await host.hostEvent(page, 'a', 'cart.line-added', { lineId: 'L1', quantity: 1 });
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-2' } });
    expect(creates()).toHaveLength(2);
    await page.close();
  });

  it('saves a new customization when the shopper changes the design', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-1' } });

    // Edit a text field, then add again.
    await typeText(page, 'a', 'input[type="text"]', 'Alex');
    await page.waitForFunction(
      (i) => (window as any).testHost.events(i, 'customizer-change').length > 1,
      { timeout: 10000 },
      'a',
    );
    const again = await host.prepare(page, 'a');
    expect(again).toEqual({ ok: true, value: { customizationId: 'cz-2' } });
    await page.close();
  });

  it('rejects with the first blocker when the design is not valid, saving nothing', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready'); // the required photo is missing
    const result = await host.prepare(page, 'a');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message.length).toBeGreaterThan(5);
    expect(env.api.shopper.requests).toHaveLength(0);
    await page.close();
  });

  it('rejects before the template is known, and when the page is not set up for the extension', async () => {
    const { page } = await openHost(env);
    // A host MUST wait for the definition before calling commands: the bundle registers asynchronously.
    await page.evaluate(() => (window as any).testHost.ready());
    await host.mount(page, 'a', { productId: 'prod-1' }); // no api-base-url / store-id
    const result = await host.prepare(page, 'a');
    expect(result).toEqual({ ok: false, message: 'Personalization is not set up for this page.', name: 'Error' });
    await page.close();
  });

  it.each([
    [429, { error: { code: 'rate_limited' } }, /too many requests/i],
    [409, { error: { code: 'conflict', details: { reason: 'config_changed' } } }, /reload the page/i],
    [404, { error: { code: 'not_personalizable' } }, /not available/i],
    [500, { error: { code: 'internal_error', message: 'stack trace here' } }, /could not be saved/i],
  ])('maps a %s from the API to a shopper-safe message and an error event without details', async (status, body, message) => {
    env.api.responses.set('prod-1', mapped());
    env.api.shopper.createAnswer = { status, body };
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');

    const result = await host.prepare(page, 'a');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(message);
    expect((result as { message: string }).message).not.toContain('stack trace');
    const errors = (await host.zbEvents(page)).filter((e) => e.type === 'error' && e.data.code === 'save-failed');
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].data).sort()).toEqual(['code', 'recoverable']);
    // A failed save is not remembered: the next attempt tries again.
    env.api.shopper.createAnswer = undefined;
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-1' } });
    await page.close();
  });

  it('maps an upload rejection (too large / unsupported) to a clear message', async () => {
    env.api.responses.set('prod-1', mapped());
    env.api.shopper.uploadAnswer = { status: 415, body: { error: { code: 'unsupported_media_type' } } };
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');
    const result = await host.prepare(page, 'a');
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/images could not be saved/i);
    expect(creates()).toHaveLength(0); // the customization is never created from a partial upload
    await page.close();
  });

  it('sends no credentials and no cookies with any shopper request', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await makeValid(page, 'a');
    await host.prepare(page, 'a');
    expect(env.api.shopper.requests.length).toBeGreaterThan(0);
    expect(env.api.requests.every((r) => r.headers['authorization'] === undefined && r.headers['cookie'] === undefined)).toBe(true);
    await page.close();
  });
});
