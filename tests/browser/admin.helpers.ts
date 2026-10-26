import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { type Environment, adminHost, clickText, upload, waitInside, writeFixture } from './harness';

export const CATALOG = [
  {
    id: 'prod-tee',
    sku: 'TEE-1',
    title: 'Classic tee',
    variants: [
      { id: 'tee-s', title: 'Small', sku: 'TEE-1-S' },
      { id: 'tee-m', title: 'Medium', sku: 'TEE-1-M' },
    ],
    collections: [{ id: 'summer', title: 'Summer' }],
  },
  { id: 'prod-mug', sku: 'MUG-1', title: 'Ceramic mug', collections: [{ id: 'kitchen', title: 'Kitchen' }] },
  { id: 'prod-cap', sku: 'CAP-1', title: 'Baseball cap' },
];

export function templateFile(name: string): string {
  const config = JSON.parse(
    readFileSync(new URL('../../public/data/products/tshirt.json', import.meta.url), 'utf8'),
  );
  config.assetBaseUrl = 'assets/';
  config.product.name = name;
  return JSON.stringify(config);
}

export const names = (page: Page, id: string, selector: string) =>
  page.evaluate(
    (i, s) => [...document.getElementById(i)!.shadowRoot!.querySelectorAll(s)].map((e) => e.textContent!.replace(/\s+/g, ' ').trim()),
    id,
    selector,
  );

export async function importTemplate(env: Environment, page: Page, id: string, name: string) {
  const file = writeFixture(env, `${name}.json`, Buffer.from(templateFile(name)));
  await upload(page, id, file);
  await page.waitForFunction(
    (i, n) => [...document.getElementById(i)!.shadowRoot!.querySelectorAll('.row-title')].some((a) => a.textContent!.includes(n)),
    { timeout: 20000 },
    id,
    name,
  );
}

export async function openEditor(page: Page, id: string, name: string) {
  await page.waitForFunction(
    (i, n) =>
      [...document.getElementById(i)!.shadowRoot!.querySelectorAll('a.row-title')].some((a) => a.textContent!.includes(n)),
    { timeout: 20000 },
    id,
    name,
  );
  await page.evaluate(
    (i, n) => {
      const link = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('a.row-title')].find((a) => a.textContent!.includes(n)) as HTMLElement;
      link.click();
    },
    id,
    name,
  );
  await adminHost.waitView(page, id, 'editor');
  await waitInside(page, id, '.editor-header');
}

export async function publishOpenTemplate(page: Page, id: string) {
  await page.waitForFunction(
    (i) => {
      const b = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('.editor-header button')].find((x) => x.textContent!.trim() === 'Publish') as HTMLButtonElement | undefined;
      return !!b && !b.disabled;
    },
    { timeout: 30000 },
    id,
  );
  await clickText(page, id, '.editor-header button', 'Publish');
  await waitInside(page, id, 'app-confirm-host dialog[open]');
  await page.evaluate((i) => {
    const dialog = document.getElementById(i)!.shadowRoot!.querySelector('app-confirm-host dialog[open]')!;
    ([...dialog.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Publish') as HTMLElement).click();
  }, id);
  await page.waitForFunction((i) => (window as any).adminHost.events(i, 'config-published').length > 0, { timeout: 30000 }, id);
}

/** Import + open + publish a template, then go back to the list. */
export async function createPublished(env: Environment, page: Page, id: string, name: string) {
  await adminHost.set(page, id, 'view', 'list');
  await adminHost.waitView(page, id, 'list');
  await waitInside(page, id, 'input[type="file"]');
  await importTemplate(env, page, id, name);
  await openEditor(page, id, name);
  await publishOpenTemplate(page, id);
  await adminHost.set(page, id, 'view', 'list');
  await adminHost.waitView(page, id, 'list');
}

