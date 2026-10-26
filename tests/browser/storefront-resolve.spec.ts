import { readFileSync } from 'node:fs';
import {
  ASSET_PATHS,
  type Environment,
  NESTED,
  clickButton,
  host,
  insideCount,
  openHost,
  startEnvironment,
  upload,
} from './harness';
import { waitForCrop, waitForSaveEnabled } from './personalization.helpers';

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
  // The API serves absolute asset URLs.
  config.assetBaseUrl = `${env.origin}${NESTED}/assets/`;
  return config;
};

const mapped = (version = 1, scope: 'product' | 'variant' | 'collection' = 'product') => {
  const config = tshirt();
  config.version = version;
  return {
    body: { data: { personalizable: true, configId: config.id, version, scope, config } },
  };
};

const props = () => ({ productId: 'prod-1', apiBaseUrl: env.origin, storeId: 'store-1' });

describe('resolve by product', () => {
  it('loads the template mapped to the product from the public endpoint, without credentials', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(), collectionIds: ['summer', 'apparel'] });
    await host.waitStatus(page, 'a', 'ready');

    const ready = await host.events(page, 'a', 'customizer-ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].detail).toMatchObject({
      productId: expect.any(String),
      templateVersion: 1,
      schemaVersion: 2,
      personalizable: true,
    });

    expect(env.api.requests).toHaveLength(1);
    const request = env.api.requests[0];
    const url = new URL(request.url, 'http://x');
    expect(url.pathname).toBe('/api/v1/storefront/personalization/products/prod-1/config');
    expect(url.searchParams.get('storeId')).toBe('store-1');
    expect(url.searchParams.get('collectionIds')).toBe('summer,apparel');
    expect(request.headers['authorization']).toBeUndefined();
    expect(request.headers['cookie']).toBeUndefined();
    await page.close();
  });

  it('reads the attribute forms (product-id, api-base-url, store-id, variant-id, collection-ids)', async () => {
    env.api.responses.set('prod-9', mapped(1, 'variant'));
    const { page } = await openHost(env);
    await host.mount(
      page,
      'a',
      {},
      {
        attributes: {
          'product-id': 'prod-9',
          'api-base-url': env.origin,
          'store-id': 'store-9',
          'variant-id': 'v-3',
          'collection-ids': 'x, y',
        },
      },
    );
    await host.waitStatus(page, 'a', 'ready');
    const url = new URL(env.api.requests[0].url, 'http://x');
    expect(url.searchParams.get('variantId')).toBe('v-3');
    expect(url.searchParams.get('collectionIds')).toBe('x,y');
    await page.close();
  });

  it('shows only the fallback slot, and says so, when nothing is mapped', async () => {
    env.api.responses.set('prod-1', { body: { data: { personalizable: false } } });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(), { fallback: 'Buy it as is' });
    await host.waitStatus(page, 'a', 'not-personalizable');
    const ready = await host.events(page, 'a', 'customizer-ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].detail).toMatchObject({
      personalizable: false,
      templateId: '',
      templateVersion: 0,
      productId: 'prod-1',
    });
    expect(await insideCount(page, 'a', '.zbc')).toBe(0);
    expect(
      await page.evaluate(() => {
        const slot = document
          .getElementById('a')!
          .shadowRoot!.querySelector('slot[name="fallback"]') as HTMLSlotElement;
        return slot.assignedNodes().map((n) => n.textContent);
      }),
    ).toEqual(['Buy it as is']);
    await page.close();
  });

  it('re-resolves when the variant changes, keeping the design when the template is unchanged', async () => {
    env.api.responses.set('prod-1', mapped(1));
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');

    await host.set(page, 'a', 'variantId', 'v-2');
    await page.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 600));
    expect(env.api.requests.length).toBeGreaterThanOrEqual(2);
    expect(new URL(env.api.requests.at(-1)!.url, 'http://x').searchParams.get('variantId')).toBe(
      'v-2',
    );
    // Same template id and version: not reloaded.
    expect(await host.events(page, 'a', 'customizer-ready')).toHaveLength(1);

    // A new published version replaces the loaded one.
    env.api.responses.set('prod-1', mapped(2));
    await host.set(page, 'a', 'variantId', 'v-3');
    await page.waitForFunction(
      () => (window as any).testHost.events('a', 'customizer-ready').length === 2,
    );
    const ready = await host.events(page, 'a', 'customizer-ready');
    expect(ready[1].detail.templateVersion).toBe(2);
    await page.close();
  });

  it('moves from a mapped template to "nothing mapped" when the product changes', async () => {
    env.api.responses.set('prod-1', mapped());
    env.api.responses.set('prod-2', { body: { data: { personalizable: false } } });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');
    await host.set(page, 'a', 'productId', 'prod-2');
    await host.waitStatus(page, 'a', 'not-personalizable');
    await host.set(page, 'a', 'productId', 'prod-1');
    await host.waitStatus(page, 'a', 'ready');
    await page.close();
  });

  it('reports a failing service as a recoverable error and recovers with "Try again"', async () => {
    env.api.responses.set('prod-1', { status: 503, body: {} });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'invalid-config');
    const errors = await host.events(page, 'a', 'customizer-error');
    expect(errors[0].detail).toMatchObject({ code: 'config-load-failed', recoverable: true });
    expect(JSON.stringify(errors[0].detail)).not.toContain('store-1');

    env.api.responses.set('prod-1', mapped());
    await page.evaluate(() => {
      const button = [...document.getElementById('a')!.shadowRoot!.querySelectorAll('button')].find(
        (b) => b.textContent!.includes('Try again'),
      )!;
      button.click();
    });
    await host.waitStatus(page, 'a', 'ready');
    await page.close();
  });

  it('an explicit config or config-url wins: the API is not asked', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(), configUrl: `${NESTED}/data/tote-photo.json` });
    await host.waitStatus(page, 'a', 'ready');
    expect(env.api.requests).toHaveLength(0);
    expect(
      (await host.events(page, 'a', 'customizer-ready'))[0].detail.personalizable,
    ).toBeUndefined();
    await page.close();
  });

  it('rejects a mapped configuration that points outside the allowed origins', async () => {
    const answer = mapped();
    (answer.body.data.config as any).assetBaseUrl = 'https://evil.example/assets/';
    env.api.responses.set('prod-1', answer);
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(), allowedAssetOrigins: [env.origin] });
    await host.waitStatus(page, 'a', 'invalid-config');
    expect(
      (await host.events(page, 'a', 'customizer-error')).some(
        (e) => e.detail.code === 'invalid-config',
      ),
    ).toBe(true);
    await page.close();
  });

  it('a mapped product can be personalized and saved like any other', async () => {
    env.api.responses.set('prod-1', mapped());
    const { page } = await openHost(env);
    await host.mount(page, 'a', props());
    await host.waitStatus(page, 'a', 'ready');

    await upload(page, 'a', ASSET_PATHS.samplePhoto);
    await waitForCrop(page, 'a');
    await waitForSaveEnabled(page, 'a');
    await clickButton(page, 'a', 'Save customization');
    await page.waitForFunction(
      () => (window as any).testHost.events('a', 'customizer-save').length === 1,
      { timeout: 30000 },
    );
    const [save] = await host.events(page, 'a', 'customizer-save');
    expect(save.detail.customization.variantId).toBe('white');
    expect(save.detail.customization.values['front-photo'].assetId).toBe(
      save.detail.assets[0].assetId,
    );
    expect(save.detail.artworkBlob.size).toBeGreaterThan(0);
    expect(save.detail.previewBlob.size).toBeGreaterThan(0);
    expect(save.detail.assets.length).toBe(1);

    await host.ack(page, 'a', { requestId: save.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 'a', 'saved');
    await page.close();
  });
});
