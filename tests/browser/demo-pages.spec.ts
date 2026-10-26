import { type Environment, NESTED, startEnvironment } from './harness';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

const newPage = async () => {
  const page = await env.browser.newPage();
  const errors: string[] = [];
  page.on(
    'console',
    (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(m.text()),
  );
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, errors };
};

describe('shipped integration demos', () => {
  it('store-admin.html loads the entry with a plain module script and drives the element', async () => {
    const { page, errors } = await newPage();
    await page.goto(`${env.elementBase}/integration-demo/store-admin.html`);
    await page.waitForFunction(
      () => document.getElementById('log')!.textContent!.includes('admin-ready'),
      { timeout: 20000 },
    );
    expect(
      await page.evaluate(() => document.getElementById('admin')!.getAttribute('data-view')),
    ).toBe('list');

    await page.select('#view', 'mapping');
    await page.waitForFunction(
      () => document.getElementById('admin')!.getAttribute('data-view') === 'mapping',
    );
    expect(await page.evaluate(() => document.getElementById('log')!.textContent)).toContain(
      'view-change {"view":"mapping"',
    );

    await page.select('#locale', 'ar');
    await page.waitForFunction(
      () =>
        document
          .getElementById('admin')!
          .shadowRoot!.querySelector('.zb-admin')!
          .getAttribute('dir') === 'rtl',
    );
    expect(errors).toEqual([]);
    await page.close();
  });

  it('storefront.html resolves a product through its fake API and honours the fallback slot', async () => {
    const { page, errors } = await newPage();
    await page.goto(`${env.elementBase}/integration-demo/storefront.html`);
    await page.waitForFunction(() => !!document.querySelector('zb-product-customizer'));
    // Switch the first instance to "resolved by product-id".
    await page.select('[data-role="sample"]', 'mapped');
    await page.waitForFunction(
      () =>
        document.querySelector('zb-product-customizer')!.getAttribute('data-status') === 'ready',
      { timeout: 20000 },
    );
    await page.select('[data-role="sample"]', 'unmapped');
    await page.waitForFunction(
      () =>
        document.querySelector('zb-product-customizer')!.getAttribute('data-status') ===
        'not-personalizable',
      { timeout: 20000 },
    );
    expect(await page.evaluate(() => document.getElementById('log')!.textContent)).toContain(
      'not personalizable',
    );
    expect(
      await page.evaluate(
        () =>
          (document.querySelector('zb-product-customizer p[slot="fallback"]') as HTMLElement)
            .textContent,
      ),
    ).toContain('normal buy box');
    expect(errors).toEqual([]);
    void NESTED;
    await page.close();
  });
});
