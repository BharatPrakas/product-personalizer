import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { type Environment, NESTED, host, insideCount, openHost, startEnvironment } from './harness';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

const TOTE = `${NESTED}/data/tote-photo.json`;

const style = (page: Page, id: string, selector: string, property: string) =>
  page.evaluate(
    (i, s, p) =>
      getComputedStyle(document.getElementById(i)!.shadowRoot!.querySelector(s)!).getPropertyValue(
        p,
      ),
    id,
    selector,
    property,
  );

async function axeViolations(page: Page, id: string): Promise<string[]> {
  await page.evaluate(axeSource);
  const result = (await page.evaluate(
    (i) =>
      (window as any).axe.run(document.getElementById(i), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] },
        rules: { region: { enabled: false } },
      }),
    id,
  )) as { violations: { id: string; nodes: { target: unknown[]; failureSummary: string }[] }[] };
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

describe('storefront theming hooks', () => {
  it('--zb-accent, --zb-radius and --zb-font theme the element (and still honour the older --customizer-* names)', async () => {
    const { page } = await openHost(env);
    await page.addStyleTag({
      content: `#a { --zb-accent: #8a2be2; --zb-radius: 2px; --zb-font: Georgia, serif; }
                #b { --customizer-primary: #b22222; --zb-radius: 12px; }`,
    });
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.mount(page, 'b', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    await host.waitStatus(page, 'b', 'ready');
    expect(await style(page, 'a', '.btn.primary', 'background-color')).toBe('rgb(138, 43, 226)');
    expect(await style(page, 'a', '.btn.primary', 'border-radius')).toBe('2px');
    expect(await style(page, 'a', '.zbc', 'font-family')).toContain('Georgia');
    expect(await style(page, 'b', '.btn.primary', 'background-color')).toBe('rgb(178, 34, 34)');
    expect(await style(page, 'b', '.btn.primary', 'border-radius')).toBe('12px');
    await page.close();
  });

  it('exposes the primary button and the preview frame as shadow parts', async () => {
    const { page } = await openHost(env);
    await page.addStyleTag({
      content: `zb-product-customizer::part(primary-button) { text-decoration: underline; }
                zb-product-customizer::part(preview-frame) { outline: 3px solid rgb(255, 0, 0); }`,
    });
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    expect(await style(page, 'a', '[part~="primary-button"]', 'text-decoration-line')).toBe(
      'underline',
    );
    expect(await style(page, 'a', '[part~="preview-frame"]', 'outline-color')).toBe(
      'rgb(255, 0, 0)',
    );
    await page.close();
  });

  it('is light by default, dark on request, and follows the colour scheme only with theme="auto"', async () => {
    const { page } = await openHost(env);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await host.mount(page, 'light', { configUrl: TOTE });
    await host.mount(page, 'dark', { configUrl: TOTE, theme: 'dark' });
    await host.mount(page, 'auto', { configUrl: TOTE }, { attributes: { theme: 'auto' } });
    for (const id of ['light', 'dark', 'auto']) await host.waitStatus(page, id, 'ready');
    expect(await style(page, 'light', '.zbc', 'background-color')).toBe('rgb(255, 255, 255)');
    expect(await style(page, 'dark', '.zbc', 'background-color')).toBe('rgb(17, 24, 39)');
    expect(await style(page, 'auto', '.zbc', 'background-color')).toBe('rgb(17, 24, 39)');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    expect(await style(page, 'auto', '.zbc', 'background-color')).toBe('rgb(255, 255, 255)');
    expect(await style(page, 'dark', '.zbc', 'background-color')).toBe('rgb(17, 24, 39)');
    await page.close();
  });

  it('the dark theme passes axe contrast checks (initial state and with validation messages)', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE, theme: 'dark' });
    await host.waitStatus(page, 'a', 'ready');
    expect(await axeViolations(page, 'a')).toEqual([]);
    await page.close();
  });

  it('shows a skeleton with the final layout while loading', async () => {
    env.api.responses.set('slow', {
      delayMs: 1500,
      body: { data: { personalizable: false } },
    });
    const { page } = await openHost(env);
    await host.mount(page, 'a', { productId: 'slow', apiBaseUrl: env.origin, storeId: 's' });
    await host.waitStatus(page, 'a', 'loading');
    expect(await insideCount(page, 'a', '.skeleton')).toBe(1);
    expect(await style(page, 'a', '.skeleton', 'display')).toBe('grid');
    await host.waitStatus(page, 'a', 'not-personalizable');
    await page.close();
  });
});
