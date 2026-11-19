/**
 * The storefront shell: eligibility-aware trigger button, lazy editor, Builder styling, rendering modes and
 * isolation. The modal and the save flows are in `storefront-modal.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { type Environment, NESTED, host, insideCount, insideText, openHost, startEnvironment } from './harness';
import {
  MANAGED,
  computed,
  configRequests,
  hasTrigger,
  mapped,
  modalOpen,
  openModal,
  props,
  recordScripts,
  trigger,
  waitForNoTrigger,
  waitForStyle,
  waitForTrigger,
  zbOf,
} from './storefront.helpers';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => env.api.reset());

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function axeViolations(page: Page, id: string): Promise<string[]> {
  await page.evaluate(axeSource);
  const result = (await page.evaluate(
    (i) =>
      (window as any).axe.run(document.getElementById(i), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { region: { enabled: false } },
      }),
    id,
  )) as { violations: { id: string; impact: string; nodes: { target: unknown[]; failureSummary: string }[] }[] };
  return result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} -> ${n.failureSummary.split('\n')[1]?.trim()}`).join(' | ')}`,
  );
}

describe('eligibility', () => {
  it('shows no trigger and renders only the fallback for a product without a published template', async () => {
    const { page } = await openHost(env); // nothing mapped -> { personalizable: false }
    await host.mount(page, 'a', props(env), { fallback: 'Not personalizable' });
    await host.waitStatus(page, 'a', 'not-personalizable');
    expect(await hasTrigger(page, 'a')).toBe(false);
    expect(await insideCount(page, 'a', 'dialog')).toBe(0);
    expect(await insideCount(page, 'a', '.zbc')).toBe(0);
    const zb = await zbOf(page, 'a');
    expect(zb.filter((e) => e.type === 'ready').map((e) => e.data)).toEqual([{ available: false }]);
    expect(zb.some((e) => e.type === 'rendered')).toBe(false);
    const ready = (await host.events(page, 'a', 'customizer-ready')).map((e) => e.detail);
    expect(ready).toEqual([{ productId: 'prod-1', templateId: '', templateVersion: 0, personalizable: false }]);
    // Nothing to personalize: Add to cart is not held back, and the editor was never downloaded.
    expect((await zbOf(page, 'a', 'gate')).at(-1)!.data).toEqual({ allowed: true });
    await page.close();
  });

  it('shows the trigger, and only the trigger, for a product with a published template', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env), { attributes: MANAGED });
    await waitForTrigger(page, 'a');
    await host.waitStatus(page, 'a', 'ready');
    expect(await insideText(page, 'a', 'button.trigger')).toBe('Personalize');
    expect(await insideCount(page, 'a', '.zbc')).toBe(0); // no editor on the page
    expect(await modalOpen(page, 'a')).toBe(false);

    const zb = await zbOf(page, 'a');
    expect(zb.filter((e) => e.type === 'ready').map((e) => e.data)).toEqual([{ available: true }]);
    await page.waitForFunction(() => (window as any).testHost.zb.some((e: any) => e.type === 'rendered'), { timeout: 10000 });
    expect((await zbOf(page, 'a', 'rendered')).length).toBe(1);
    // Add to cart waits for the shopper to personalize.
    const gate = (await zbOf(page, 'a', 'gate')).at(-1)!;
    expect(gate.data).toMatchObject({ allowed: false });
    expect(typeof gate.data.reason).toBe('string');

    const ready = (await host.events(page, 'a', 'customizer-ready')).map((e) => e.detail);
    expect(ready).toEqual([
      { productId: expect.any(String), templateId: 'tshirt-personalization', templateVersion: 1, schemaVersion: 2, personalizable: true },
    ]);
    await page.close();
  });

  it('shows no button while the answer is pending, then the button; one request only', async () => {
    env.api.responses.set('prod-1', { ...mapped(env), delayMs: 500 });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env));
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-status') === 'loading', { timeout: 5000 });
    expect(await hasTrigger(page, 'a')).toBe(false);
    await waitForTrigger(page, 'a');
    expect(configRequests(env)).toHaveLength(1);
    await page.close();
  });

  it('asks for the variant and collections it was given', async () => {
    env.api.responses.set('prod-1', mapped(env, { scope: 'variant' }));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), variantId: 'v-9', collectionIds: ['c-1', 'c-2'] });
    await waitForTrigger(page, 'a');
    const url = new URL(configRequests(env)[0].url, 'http://x');
    expect(url.searchParams.get('variantId')).toBe('v-9');
    expect(url.searchParams.get('collectionIds')).toBe('c-1,c-2');
    expect(url.searchParams.get('storeId')).toBe('store-1');
    await page.close();
  });

  it('shows no misleading button when the service fails, and recovers with Try again', async () => {
    env.api.responses.set('prod-1', { status: 500, body: { error: { code: 'internal_error' } } });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env));
    await host.waitStatus(page, 'a', 'invalid-config');
    expect(await hasTrigger(page, 'a')).toBe(false);
    expect(await insideText(page, 'a', '.unavailable')).toContain('temporarily unavailable');
    expect((await zbOf(page, 'a', 'gate')).at(-1)!.data.allowed).toBe(false);

    env.api.responses.set('prod-1', mapped(env));
    await page.evaluate(() => (document.getElementById('a')!.shadowRoot!.querySelector('.unavailable button') as HTMLButtonElement).click());
    await waitForTrigger(page, 'a');
    await page.close();
  });

  it('hides the button at once when the product changes, and ignores a stale answer', async () => {
    env.api.responses.set('slow', { ...mapped(env), delayMs: 700 });
    env.api.responses.set('fast', { body: { data: { personalizable: false } } });
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env, 'slow'));
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-status') === 'loading');
    await host.set(page, 'a', 'productId', 'fast'); // while the first answer is still on its way
    await host.waitStatus(page, 'a', 'not-personalizable');
    await new Promise((resolve) => setTimeout(resolve, 1000)); // the slow answer arrives and is ignored
    expect(await hasTrigger(page, 'a')).toBe(false);
    expect(await host.get(page, 'a', 'productId')).toBe('fast');
    await host.waitStatus(page, 'a', 'not-personalizable');
    await page.close();
  });

  it('hides the button until a changed variant is known, and does not repeat an unchanged request', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), variantId: 'v1' });
    await waitForTrigger(page, 'a');
    expect(configRequests(env)).toHaveLength(1);

    env.api.responses.set('prod-1', { ...mapped(env), delayMs: 600 });
    await host.set(page, 'a', 'variantId', 'v2');
    await waitForNoTrigger(page, 'a', 2000); // eligibility for v2 is unknown: no button
    await waitForTrigger(page, 'a');
    expect(configRequests(env)).toHaveLength(2);

    // The same collections again (a new array, equal content) is not a new question.
    await host.set(page, 'a', 'collectionIds', []);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(configRequests(env)).toHaveLength(2);
    await page.close();
  });

  it('frequent variant changes leave only the last answer standing', async () => {
    env.api.responses.set('prod-1', { ...mapped(env), delayMs: 150 });
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), variantId: 'v0' });
    await waitForTrigger(page, 'a');
    for (const variant of ['v1', 'v2', 'v3', 'v4']) await host.set(page, 'a', 'variantId', variant);
    await waitForTrigger(page, 'a');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await hasTrigger(page, 'a')).toBe(true);
    const last = new URL(configRequests(env).at(-1)!.url, 'http://x');
    expect(last.searchParams.get('variantId')).toBe('v4');
    await page.close();
  });
});

describe('lazy editor', () => {
  it('downloads and creates no editor before the shopper clicks, and asks the API once in total', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    const scripts = recordScripts(page);
    await host.mount(page, 'a', props(env), { attributes: MANAGED });
    await waitForTrigger(page, 'a');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = scripts.mark();
    expect(await insideCount(page, 'a', 'app-personalizer-editor')).toBe(0);
    expect(await insideCount(page, 'a', 'canvas')).toBe(0);

    await openModal(page, 'a');
    // The editor chunk (and what only it needs) arrived because of the click, not before.
    expect(scripts.since(before).some((url) => /\/chunk-[^/]+\.js/.test(url))).toBe(true);
    expect(await insideCount(page, 'a', 'app-personalizer-editor')).toBe(1);
    expect(configRequests(env)).toHaveLength(1); // the answer already in hand is reused
    await page.close();
  });

  it('the download graph of the storefront entry does not contain the editor', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../../dist/PRODUCT_PERSONALIZATION/MANIFEST.json', import.meta.url), 'utf8'));
    const entry = manifest.entries['storefront.js'];
    const initial = (entry.initialFiles as string[]).map((f) => readFileSync(new URL(`../../dist/PRODUCT_PERSONALIZATION/${f}`, import.meta.url), 'utf8')).join('\n');
    // Code that only the editor needs stays out of what every shopper downloads.
    expect(initial).not.toContain('Waiting for configuration');
    expect(initial).not.toContain('Before you can save');
    expect(entry.initialBytes).toBeLessThan(440 * 1024);
  });
});

describe('Builder styling of the trigger', () => {
  const builder = {
    buttonText: 'Design your own',
    buttonColor: '#0a5c36',
    buttonTextColor: '#ffffff',
    buttonFont: 'Georgia, serif',
    buttonTextSize: 20,
    buttonTextFontStyle: ['B'],
    buttonRadius: 24,
    buttonPadding: 14,
    width: 320,
    buttonBorderColor: '#112233',
    buttonBorderThickness: 3,
    buttonAlignment: 'center',
  };

  it('follows the style given as a property, and overrides the defaults', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), triggerStyle: builder });
    await waitForTrigger(page, 'a');
    expect(await insideText(page, 'a', 'button.trigger')).toBe('Design your own');
    const style = await computed(page, 'a', 'button.trigger', [
      'background-color', 'color', 'font-size', 'font-weight', 'border-top-left-radius', 'padding-top', 'padding-left', 'width', 'border-top-width', 'border-top-color', 'font-family',
    ] as const);
    expect(style).toMatchObject({
      'background-color': 'rgb(10, 92, 54)',
      color: 'rgb(255, 255, 255)',
      'font-size': '20px',
      'font-weight': '700',
      'border-top-left-radius': '24px',
      'padding-top': '14px',
      'padding-left': '28px',
      width: '320px',
      'border-top-width': '3px',
      'border-top-color': 'rgb(17, 34, 51)',
    });
    expect(style['font-family']).toContain('Georgia');
    expect(await computed(page, 'a', '.trigger-wrap', ['justify-content'])).toEqual({ 'justify-content': 'center' });
    await page.close();
  });

  it('reads the style from the trigger-style attribute (JSON) too', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env), { attributes: { 'trigger-style': JSON.stringify({ buttonText: 'From attribute', buttonColor: '#7a1f1f' }) } });
    await waitForTrigger(page, 'a');
    expect(await insideText(page, 'a', 'button.trigger')).toBe('From attribute');
    expect((await computed(page, 'a', 'button.trigger', ['background-color']))['background-color']).toBe('rgb(122, 31, 31)');
    await page.close();
  });

  it('restyles in place when the style changes: no new request, no editor, same element', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), triggerStyle: builder });
    await waitForTrigger(page, 'a');
    const scripts = recordScripts(page);
    const before = await trigger(page, 'a');
    await page.evaluate(() => ((window as any).__btn = document.getElementById('a')!.shadowRoot!.querySelector('button.trigger')));

    await host.set(page, 'a', 'triggerStyle', { buttonText: 'Now green', buttonColor: '#006400', buttonRadius: 2 });
    await page.waitForFunction(() => document.getElementById('a')!.shadowRoot!.querySelector('button.trigger')!.textContent!.trim() === 'Now green');
    await waitForStyle(page, 'a', 'button.trigger', 'background-color', 'rgb(0, 100, 0)');
    expect((await computed(page, 'a', 'button.trigger', ['border-top-left-radius']))['border-top-left-radius']).toBe('2px');
    // The properties the new style does not mention fall back to the defaults.
    expect((await computed(page, 'a', 'button.trigger', ['width']))['width']).not.toBe('320px');

    expect(await page.evaluate(() => (window as any).__btn === document.getElementById('a')!.shadowRoot!.querySelector('button.trigger'))).toBe(true);
    expect(configRequests(env)).toHaveLength(1);
    expect(scripts.urls).toHaveLength(0);
    expect(await insideCount(page, 'a', 'app-personalizer-editor')).toBe(0);
    void before;
    await page.close();
  });

  it('applies hover colours', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonColor: '#0a5c36', buttonHoverColor: '#8a1c7c', buttonHoverTextColor: '#ffffff' } });
    await waitForTrigger(page, 'a');
    await (await trigger(page, 'a')).hover();
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('a')!.shadowRoot!.querySelector('button.trigger')!).backgroundColor === 'rgb(138, 28, 124)',
      { timeout: 3000 },
    );
    await page.close();
  });

  it('ignores hostile values and keeps the defaults, without adding a rule anywhere', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    const headStyles = await page.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').length);
    await host.mount(page, 'a', {
      ...props(env),
      triggerStyle: {
        buttonColor: 'url(https://evil.example/x.png)',
        buttonTextColor: 'var(--page-secret)',
        buttonFont: 'x; } body { display: none',
        buttonBorderColor: 'red; position: fixed',
        buttonRadius: '9999px',
        width: 'calc(100vw + 99px)',
        buttonText: '<img src=x onerror="window.__xss=1">',
      },
    });
    await waitForTrigger(page, 'a');
    const style = await computed(page, 'a', 'button.trigger', ['background-color', 'color', 'border-top-left-radius', 'width', 'position']);
    expect(style['background-color']).toBe('rgb(41, 111, 215)'); // the default accent
    expect(style['color']).toBe('rgb(255, 255, 255)');
    expect(style['border-top-left-radius']).toBe('8px');
    expect(style['position']).toBe('static');
    expect(parseFloat(style['width'])).toBeLessThan(400);
    // The label is text: it is shown, never parsed as markup.
    expect(await insideText(page, 'a', 'button.trigger')).toContain('<img src=x');
    expect(await insideCount(page, 'a', 'button.trigger img')).toBe(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
    expect(await page.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').length)).toBe(headStyles);
    await page.close();
  });

  it('keeps the text readable on a background the merchant chose', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonColor: '#ffeb3b', buttonTextColor: '#ffffff' } });
    await waitForTrigger(page, 'a');
    expect((await computed(page, 'a', 'button.trigger', ['color']))['color']).toBe('rgb(17, 24, 39)');
    await page.close();
  });

  it('has a visible keyboard focus indicator whatever the merchant picked', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonColor: '#111827', buttonBorderColor: '#111827', buttonBorderThickness: 2 } });
    await waitForTrigger(page, 'a');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.getElementById('a')!.shadowRoot!.activeElement?.classList.contains('trigger'));
    expect(focused).toBe(true);
    const ring = await computed(page, 'a', 'button.trigger', ['outline-style', 'outline-width', 'outline-color', 'box-shadow']);
    expect(ring['outline-style']).toBe('solid');
    expect(ring['outline-width']).toBe('3px');
    expect(ring['box-shadow']).not.toBe('none');
    await page.close();
  });

  it('shows the disabled appearance and ignores clicks while the host disables the element', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonDisabledColor: '#cccccc', buttonDisabledTextColor: '#555555' } });
    await waitForTrigger(page, 'a');
    await host.set(page, 'a', 'disabled', true);
    await page.waitForFunction(() => (document.getElementById('a')!.shadowRoot!.querySelector('button.trigger') as HTMLButtonElement).disabled);
    await waitForStyle(page, 'a', 'button.trigger', 'background-color', 'rgb(204, 204, 204)');
    await page.evaluate(() => (document.getElementById('a')!.shadowRoot!.querySelector('button.trigger') as HTMLButtonElement).click());
    expect(await modalOpen(page, 'a')).toBe(false);
    expect((await zbOf(page, 'a', 'gate')).at(-1)!.data.allowed).toBe(false);
    await page.close();
  });
});

describe('rendering modes', () => {
  it('`preview` renders the editor inline and no trigger, even for a mapped product', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env), { attributes: { mode: 'preview' } });
    await host.waitStatus(page, 'a', 'ready');
    expect(await hasTrigger(page, 'a')).toBe(false);
    expect(await insideCount(page, 'a', 'dialog')).toBe(0);
    expect(await insideCount(page, 'a', '.zbc form')).toBe(1);
    expect(await page.evaluate(() => document.getElementById('a')!.getAttribute('data-mode'))).toBe('preview');
    await page.close();
  });

  it('a host-supplied configuration is the editor inline, with no trigger and no API call', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: `${NESTED}/data/tote-photo.json` });
    await host.waitStatus(page, 'a', 'ready');
    expect(await hasTrigger(page, 'a')).toBe(false);
    expect(await insideCount(page, 'a', '.zbc form')).toBe(1);
    expect(configRequests(env)).toHaveLength(0);
    await page.close();
  });

  it('`storefront` with a host-supplied configuration shows the trigger straight away', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: `${NESTED}/data/tote-photo.json` }, { attributes: { mode: 'storefront' } });
    await waitForTrigger(page, 'a');
    expect(await insideCount(page, 'a', '.zbc')).toBe(0);
    await openModal(page, 'a');
    expect(await insideCount(page, 'a', 'dialog .zbc form')).toBe(1);
    await page.close();
  });

  it('switching the mode while mounted swaps trigger and inline editor', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env));
    await waitForTrigger(page, 'a');
    await host.set(page, 'a', 'mode', 'preview');
    await host.waitStatus(page, 'a', 'ready');
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.zbc form'));
    expect(await hasTrigger(page, 'a')).toBe(false);
    await host.set(page, 'a', 'mode', 'storefront');
    await waitForTrigger(page, 'a');
    expect(await insideCount(page, 'a', '.zbc')).toBe(0);
    await page.close();
  });
});

describe('isolation', () => {
  it('two instances do not interfere: separate state, events and modals', async () => {
    env.api.responses.set('prod-1', mapped(env));
    env.api.responses.set('prod-2', mapped(env));
    const { page } = await openHost(env);
    await host.mount(page, 'a', props(env, 'prod-1'), { attributes: { ...MANAGED, 'instance-id': 'inst-a' } });
    await host.mount(page, 'b', props(env, 'prod-2'), { attributes: { ...MANAGED, 'instance-id': 'inst-b' } });
    await waitForTrigger(page, 'a');
    await waitForTrigger(page, 'b');
    await openModal(page, 'a');
    expect(await modalOpen(page, 'a')).toBe(true);
    expect(await modalOpen(page, 'b')).toBe(false);
    expect(await insideCount(page, 'b', 'app-personalizer-editor')).toBe(0);
    expect(await insideCount(page, 'a', 'app-personalizer-editor')).toBe(1);
    // Events are attributed to the right instance.
    const zb = await host.zbEvents(page);
    expect(new Set(zb.filter((e) => e.targetId === 'a').map((e) => e.instanceId))).toEqual(new Set(['inst-a']));
    expect(new Set(zb.filter((e) => e.targetId === 'b').map((e) => e.instanceId))).toEqual(new Set(['inst-b']));
    // Removing one leaves the other working.
    await page.keyboard.press('Escape');
    await host.remove(page, 'a');
    await (await trigger(page, 'b')).click();
    await page.waitForFunction(() => !!(document.getElementById('b')!.shadowRoot!.querySelector('dialog.modal') as HTMLDialogElement).open);
    await page.close();
  });

  it('host CSS cannot restyle the trigger or the modal, and the element adds no CSS to the page', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page } = await openHost(env, { query: '?hostile=1' });
    const before = await page.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').length);
    await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonTextSize: 18, buttonPadding: 12 } });
    await waitForTrigger(page, 'a');
    const style = await computed(page, 'a', 'button.trigger', ['font-size', 'letter-spacing', 'text-transform', 'font-style', 'position', 'border-top-style']);
    expect(style).toMatchObject({ 'font-size': '18px', 'letter-spacing': 'normal', 'text-transform': 'none', 'font-style': 'normal', position: 'static' });
    await openModal(page, 'a');
    const panel = await computed(page, 'a', '.modal-panel', ['font-size', 'letter-spacing', 'text-transform']);
    expect(panel).toMatchObject({ 'font-size': '16px', 'letter-spacing': 'normal', 'text-transform': 'none' });
    expect(await page.evaluate(() => document.querySelectorAll('style, link[rel=stylesheet]').length)).toBe(before);
    await page.close();
  });

  it('works under a strict style-src CSP: trigger styles, the modal and the editor', async () => {
    env.api.responses.set('prod-1', mapped(env));
    const { page, consoleErrors } = await openHost(env, { page: 'host-csp.html' });
    await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonColor: '#0a5c36', buttonRadius: 20, buttonText: 'CSP ok' } }, { attributes: MANAGED });
    await waitForTrigger(page, 'a');
    expect((await computed(page, 'a', 'button.trigger', ['background-color']))['background-color']).toBe('rgb(10, 92, 54)');
    await openModal(page, 'a');
    expect(consoleErrors.filter((m) => /Content Security Policy|CSP/i.test(m))).toEqual([]);
    await page.close();
  });
});

describe('accessibility', () => {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 360, height: 740 }]) {
    it(`the trigger, the unavailable state and a restyled trigger have no axe violations at ${viewport.width}px`, async () => {
      env.api.responses.set('prod-1', mapped(env));
      env.api.responses.set('broken', { status: 500, body: {} });
      const { page } = await openHost(env, { viewport });
      await host.mount(page, 'a', { ...props(env), triggerStyle: { buttonColor: '#0a5c36', buttonText: 'Personalize this gift' } });
      await host.mount(page, 'b', props(env, 'broken'));
      await waitForTrigger(page, 'a');
      await host.waitStatus(page, 'b', 'invalid-config');
      expect(await axeViolations(page, 'a')).toEqual([]);
      expect(await axeViolations(page, 'b')).toEqual([]);
      await page.close();
    });
  }
});
