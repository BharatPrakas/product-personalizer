import {
  type Environment,
  NESTED,
  host,
  inside,
  insideAll,
  insideCount,
  openHost,
  startEnvironment,
} from './harness';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

const TOTE = `${NESTED}/data/tote-photo.json`;
const notFavicon = (messages: string[]) =>
  messages.filter((m) => !m.includes('favicon') && !m.includes('404'));

describe('A01 / A12: plain HTML host, no Angular on the page', () => {
  it('loads from a nested path using only the entry module, and renders every configured control', async () => {
    const { page, consoleErrors, pageErrors } = await openHost(env);
    const stylesBefore = await page.evaluate(() => document.styleSheets.length);

    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');

    // ready fired exactly once
    expect(await host.events(page, 'a', 'customizer-ready')).toEqual([
      {
        type: 'customizer-ready',
        detail: { productId: 'tote-001', templateId: 'tote-name-photo', templateVersion: 1 },
        bubbles: false,
      },
    ]);

    // controls
    expect(await insideCount(page, 'a', 'input[type="text"]')).toBe(1);
    expect(await insideCount(page, 'a', 'input[type="file"]')).toBe(1);
    expect(await insideCount(page, 'a', 'label.card')).toBe(7); // 6 artwork choices + "None" (optional field)
    expect(await insideAll(page, 'a', 'select option')).toEqual(['Sans', 'Serif bold']);
    expect(await insideCount(page, 'a', '.swatch')).toBe(2);

    // the mockup is drawn: the bag body is an opaque, non-white colour
    const pixel = await page.evaluate(() => {
      const canvas = document
        .getElementById('a')!
        .shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
      return [
        ...canvas
          .getContext('2d')!
          .getImageData(Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.88), 1, 1)
          .data,
      ];
    });
    expect(pixel[3]).toBe(255);
    expect(pixel.slice(0, 3)).not.toEqual([255, 255, 255]);

    // no framework on the host page, no host CSS touched, nothing logged as an error
    expect(await page.evaluate(() => typeof (window as any).Zone)).toBe('undefined');
    expect(await page.evaluate(() => typeof (window as any).ng)).not.toBe('function');
    expect(await page.evaluate(() => document.styleSheets.length)).toBe(stylesBefore);
    expect(notFavicon(consoleErrors)).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('resolves assets relative to the config URL under a nested base path (assetBaseUrl "../assets/")', async () => {
    const { page } = await openHost(env);
    const requested: string[] = [];
    page.on('request', (request) => requested.push(new URL(request.url()).pathname));
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    expect(requested).toEqual(
      expect.arrayContaining([
        `${NESTED}/data/tote-photo.json`,
        `${NESTED}/assets/mockups/tote-natural.jpg`,
        `${NESTED}/assets/fonts/sans-regular.woff2`,
        `${NESTED}/assets/clipart/star.png`,
      ]),
    );
    await page.close();
  });

  it('accepts a config object plus baseUrl, and the config-url / disabled attributes', async () => {
    const { page } = await openHost(env);
    const config = await page.evaluate(async (url) => (await fetch(url)).json(), TOTE);
    // Object configuration resolves "../assets/" against baseUrl (a directory), not the page.
    await host.mount(page, 'obj', { config, baseUrl: `${env.origin}${NESTED}/data/` });
    await host.mount(page, 'attr', {}, { attributes: { 'config-url': TOTE } });
    await host.waitStatus(page, 'obj', 'ready');
    await host.waitStatus(page, 'attr', 'ready');
    expect(await host.get(page, 'attr', 'configUrl')).toBe(TOTE);

    // disabled: absent=false, empty=true, "true"=true, "false"=false
    expect(await host.get(page, 'attr', 'disabled')).toBe(false);
    await page.evaluate(() => document.getElementById('attr')!.setAttribute('disabled', ''));
    expect(await host.get(page, 'attr', 'disabled')).toBe(true);
    await page.evaluate(() => document.getElementById('attr')!.setAttribute('disabled', 'false'));
    expect(await host.get(page, 'attr', 'disabled')).toBe(false);
    await page.evaluate(() => document.getElementById('attr')!.setAttribute('disabled', 'true'));
    expect(await host.get(page, 'attr', 'disabled')).toBe(true);
    await page.evaluate(() => document.getElementById('attr')!.removeAttribute('disabled'));
    expect(await host.get(page, 'attr', 'disabled')).toBe(false);

    // host disabled: inputs and Save are disabled
    await host.set(page, 'attr', 'disabled', true);
    await page.waitForFunction(
      () =>
        (
          document
            .getElementById('attr')!
            .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement
        ).disabled,
    );
    expect((await insideAll(page, 'attr', 'button.primary', 'disabled'))[0]).toBe(true);
    await page.close();
  });

  it('shows "awaiting configuration" (no crash, no error event) until a config arrives, and rejects both config and configUrl', async () => {
    const { page, pageErrors } = await openHost(env);
    await host.mount(page, 'a');
    await host.waitStatus(page, 'a', 'awaiting-config');
    expect(await host.events(page, 'a', 'customizer-error')).toEqual([]);

    const config = await page.evaluate(async (url) => (await fetch(url)).json(), TOTE);
    await host.set(page, 'a', 'configUrl', TOTE);
    await host.set(page, 'a', 'config', config);
    await host.waitStatus(page, 'a', 'invalid-config');
    const errors = await host.events<{ code: string }>(page, 'a', 'customizer-error');
    expect(errors.map((e) => e.detail.code)).toContain('config-conflict');
    expect(await insideCount(page, 'a', 'input[type="text"]')).toBe(0);

    await host.set(page, 'a', 'config', null);
    await host.waitStatus(page, 'a', 'ready');
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('reports an invalid configuration with readable problems and never shows editable controls', async () => {
    const { page } = await openHost(env);
    const config = await page.evaluate(async (url) => {
      const c = await (await fetch(url)).json();
      c.schemaVersion = 7;
      return c;
    }, TOTE);
    await host.mount(page, 'bad', { config, baseUrl: `${env.origin}${NESTED}/data/` });
    await host.waitStatus(page, 'bad', 'invalid-config');
    const [error] = await host.events<{ code: string; message: string; recoverable: boolean }>(
      page,
      'bad',
      'customizer-error',
    );
    expect(error.detail.code).toBe('invalid-config');
    expect(error.detail.message).toContain('schemaVersion');
    expect(await insideCount(page, 'bad', 'input')).toBe(0);
    await page.close();
  });

  it('events are non-bubbling CustomEvents on the element itself', async () => {
    const { page } = await openHost(env);
    const bubbled = await page.evaluate(() => {
      let seen = 0;
      document.addEventListener('customizer-ready', () => seen++);
      return new Promise<number>((resolve) => {
        (window as any).testHost.mount('a', {
          configUrl: '/nested/path/customizer/data/tote-photo.json',
        });
        document
          .getElementById('a')!
          .addEventListener('customizer-ready', () => setTimeout(() => resolve(seen), 50));
      });
    });
    expect(bubbled).toBe(0);
    await page.close();
  });
});

describe('A15: registration and lifecycle', () => {
  it('importing the module again (same or different URL) does not bootstrap or define twice', async () => {
    const { page, consoleErrors, pageErrors } = await openHost(env, { query: '?import=none' });
    await page.evaluate(() => {
      const original = customElements.define.bind(customElements);
      (window as any).defineCalls = 0;
      customElements.define = (
        name: string,
        ctor: CustomElementConstructor,
        options?: ElementDefinitionOptions,
      ) => {
        if (name === 'zb-product-customizer') (window as any).defineCalls++;
        original(name, ctor, options);
      };
    });
    await page.evaluate(async (base) => {
      await (window as any).testHost.importAgain(`${base}/product-customizer.js`);
      await (window as any).testHost.importAgain(`${base}/product-customizer.js`);
      await (window as any).testHost.importAgain(`${base}/product-customizer.js?v=2`);
    }, NESTED);
    // A *second copy* of the bundle code (different module URL) must also be a no-op.
    const mainFile = await page.evaluate(async (base) => {
      const shim = await (await fetch(`${base}/product-customizer.js`)).text();
      return /import '\.\/(main(?:-[^']+)?\.js)'/.exec(shim)![1];
    }, NESTED);
    await page.evaluate(async (url) => {
      await (window as any).testHost.importAgain(url);
    }, `${NESTED}/${mainFile}?copy=2`);
    await page.evaluate(() => customElements.whenDefined('zb-product-customizer'));
    expect(await page.evaluate(() => (window as any).defineCalls)).toBe(1);

    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    expect(await host.events(page, 'a', 'customizer-ready')).toHaveLength(1);
    expect(notFavicon(consoleErrors)).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('a removed element stops emitting, and a fresh element can be created and restored from the saved design', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'first', { configUrl: TOTE });
    await host.waitStatus(page, 'first', 'ready');

    // make a valid design and save it so there is something to restore
    const { fillTote } = await import('./personalization.helpers');
    await fillTote(page, env, 'first', { name: 'Restore Me' });
    await host.waitSaveState(page, 'first', 'awaiting-host');
    const [save] = await host.events<{ requestId: string }>(page, 'first', 'customizer-save');
    await host.ack(page, 'first', { requestId: save.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 'first', 'saved');

    await host.remove(page, 'first');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100))); // Angular Elements destroys after ~10 ms
    const countAfterRemoval = (await host.events(page, 'first')).length;

    await host.remountFromSave(page, 'first', 'second', { configUrl: TOTE });
    await host.waitStatus(page, 'second', 'ready');
    const [change] = (
      await host.events<{ valid: boolean; dirty: boolean; draft: any }>(
        page,
        'second',
        'customizer-change',
      )
    ).slice(-1);
    expect(change.detail.valid).toBe(true);
    expect(change.detail.dirty).toBe(false); // a restored draft is the clean baseline
    expect(change.detail.draft.values.name.text).toBe('Restore Me');
    expect(await host.events(page, 'first')).toHaveLength(countAfterRemoval);
    expect(
      await page.evaluate(
        () =>
          (
            document
              .getElementById('second')!
              .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement
          ).value,
      ),
    ).toBe('Restore Me');
    await page.close();
  });
});

describe('A16: aggressive host CSS and theme variables', () => {
  it('keeps the internal layout intact under hostile global CSS', async () => {
    const { page } = await openHost(env, { query: '?hostile=1' });
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');

    const metrics = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const style = (selector: string) => getComputedStyle(root.querySelector(selector)!);
      const rect = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
      return {
        letterSpacing: style('.zbc').letterSpacing,
        textTransform: style('.control').textTransform,
        whiteSpace: style('.label').whiteSpace,
        fontStyle: style('.label').fontStyle,
        fontFamily: style('.label').fontFamily,
        color: style('.label').color,
        inputHeight: rect('input[type="text"]').height,
        inputWidth: rect('input[type="text"]').width,
        canvasWidth: rect('canvas.preview-canvas').width,
        layoutColumns: style('.layout').gridTemplateColumns.split(' ').length,
        hostOverflows:
          document.getElementById('a')!.scrollWidth > document.getElementById('a')!.clientWidth,
      };
    });
    expect(metrics.letterSpacing).toBe('normal');
    expect(metrics.textTransform).toBe('none');
    expect(metrics.whiteSpace).toBe('normal');
    expect(metrics.fontStyle).toBe('normal');
    expect(metrics.fontFamily).not.toContain('Comic');
    expect(metrics.color).not.toBe('rgb(0, 255, 0)');
    expect(metrics.inputHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.inputWidth).toBeGreaterThan(200);
    expect(metrics.canvasWidth).toBeGreaterThan(300);
    expect(metrics.layoutColumns).toBe(2);
    expect(metrics.hostOverflows).toBe(false);
    await page.close();
  });

  it('honours the documented CSS custom properties, set on the element or an ancestor', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    await page.evaluate(() => {
      document.body.style.setProperty('--customizer-primary', 'rgb(255, 0, 170)'); // ancestor
      const el = document.getElementById('a')!;
      el.style.setProperty('--customizer-radius', '20px');
      el.style.setProperty('--customizer-font-family', 'Georgia, serif');
      el.style.setProperty('--customizer-border-color', 'rgb(1, 2, 3)');
    });
    const themed = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const style = (selector: string) => getComputedStyle(root.querySelector(selector)!);
      return {
        primaryBg: style('.btn.primary').backgroundColor,
        radius: style('.control').borderRadius,
        font: style('.zbc').fontFamily,
        border: style('input[type="text"]').borderTopColor,
      };
    });
    expect(themed.primaryBg).toBe('rgb(255, 0, 170)');
    expect(themed.radius).toBe('20px');
    expect(themed.font).toContain('Georgia');
    expect(themed.border).toBe('rgb(1, 2, 3)');
    await page.close();
  });

  it('defaults to ZenBasket blue #296FD7', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    const bg = await page.evaluate(
      () =>
        getComputedStyle(document.getElementById('a')!.shadowRoot!.querySelector('.btn.primary')!)
          .backgroundColor,
    );
    expect(bg).toBe('rgb(41, 111, 215)');
    await page.close();
  });
});

describe('A17: cross-origin assets and CORS', () => {
  it('loads assets and fonts from another origin that sends CORS headers', async () => {
    const { page } = await openHost(env);
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await host.mount(page, 'a', { configUrl: `${env.corsOrigin}/data/tote-photo.json` });
    await host.waitStatus(page, 'a', 'ready');
    expect(
      requested.some((url) => url.startsWith(`${env.corsOrigin}/assets/mockups/tote-natural.jpg`)),
    ).toBe(true);
    expect(
      requested.some((url) => url.startsWith(`${env.corsOrigin}/assets/fonts/sans-regular.woff2`)),
    ).toBe(true);
    await page.close();
  });

  it('reports a readable error, and never a half-working editor, when the asset origin lacks CORS', async () => {
    const { page, pageErrors } = await openHost(env);
    const config = await page.evaluate(async (url) => (await fetch(url)).json(), TOTE);
    // Config object comes from our own origin; its assets point at an origin without CORS headers.
    await host.mount(page, 'a', { config, baseUrl: `${env.noCorsOrigin}/data/` });
    await host.waitStatus(page, 'a', 'asset-error');
    const errors = await host.events<{ code: string; message: string }>(
      page,
      'a',
      'customizer-error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.message).toMatch(/CORS|cross-origin/i);
    expect(errors[0].detail.message).not.toMatch(/undefined|\[object/);
    expect(await host.events(page, 'a', 'customizer-ready')).toEqual([]);
    expect(await insideCount(page, 'a', 'input')).toBe(0);
    expect(
      await page.evaluate(
        () =>
          document.getElementById('a')!.shadowRoot!.querySelector('[role="alert"]')!.textContent,
      ),
    ).toMatch(/CORS|cross-origin/i);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('enforces the host origin allow-list for assets', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', {
      configUrl: `${env.corsOrigin}/data/tote-photo.json`,
      allowedAssetOrigins: [env.origin],
    });
    await host.waitStatus(page, 'a', 'invalid-config');
    const [error] = await host.events<{ message: string }>(page, 'a', 'customizer-error');
    expect(error.detail.message).toContain('allowed asset origins');
    await page.close();
  });
});

describe('strict Content-Security-Policy host', () => {
  it('works with no inline script, no eval, nonce-only styles and same-origin network access', async () => {
    const { page, consoleErrors } = await openHost(env, { page: 'host-csp.html' });
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (v: string) => violations.push(v));
    await page.evaluate(() =>
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as any).reportViolation(`${e.violatedDirective}: ${e.blockedURI}`),
      ),
    );

    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');

    // the element's own styles were applied (they carry the host's nonce), not blocked
    const styled = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      return {
        primary: getComputedStyle(root.querySelector('.btn.primary')!).backgroundColor,
        nonces: [...root.querySelectorAll('style')].map((s) => s.nonce || s.getAttribute('nonce')),
      };
    });
    expect(styled.primary).toBe('rgb(41, 111, 215)');
    expect(styled.nonces.length).toBeGreaterThan(0);
    expect(styled.nonces.every((n) => n === 'zbtest123')).toBe(true);

    // and a complete flow still works: type, upload, save
    const { fillTote } = await import('./personalization.helpers');
    await fillTote(page, env, 'a', { name: 'CSP' });
    await host.waitSaveState(page, 'a', 'awaiting-host');
    expect(await host.events(page, 'a', 'customizer-save')).toHaveLength(1);
    expect(violations).toEqual([]);
    expect(consoleErrors.filter((m) => /Content Security Policy|Refused to/i.test(m))).toEqual([]);
    await page.close();
  });
});
