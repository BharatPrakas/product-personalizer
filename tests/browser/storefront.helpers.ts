/**
 * Shared by the storefront trigger / modal specs: the mapped-product answer, mounting helpers, and small readers
 * of what the shell (trigger, dialog) shows. Everything is inside the element's one shadow root.
 */
import { readFileSync } from 'node:fs';
import type { ElementHandle, Page } from 'puppeteer-core';
import { ASSET_PATHS, type Environment, NESTED, host, inside, insideCount, upload } from './harness';
import { waitForCrop } from './personalization.helpers';

/** The published T-shirt template as the API serves it, with assets resolved against the test origin. */
export function tshirt(env: Environment) {
  const config = JSON.parse(
    readFileSync(new URL('../../public/data/products/tshirt.json', import.meta.url), 'utf8'),
  );
  config.assetBaseUrl = `${env.origin}${NESTED}/assets/`;
  return config;
}

export function mapped(env: Environment, overrides: { version?: number; scope?: string } = {}) {
  const config = tshirt(env);
  if (overrides.version) config.version = overrides.version;
  return {
    body: {
      data: {
        personalizable: true,
        configId: config.id,
        version: config.version,
        scope: overrides.scope ?? 'product',
        config,
      },
    },
  };
}

export const props = (env: Environment, productId = 'prod-1') => ({
  productId,
  apiBaseUrl: env.origin,
  storeId: 'store-1',
});

/** The extension-managed flavour: the host's Add to cart is the primary action, the element saves to the API itself. */
export const MANAGED = { 'hide-save': '' };

export const trigger = (page: Page, id: string) => inside(page, id, 'button.trigger');

export const hasTrigger = async (page: Page, id: string) => (await insideCount(page, id, 'button.trigger')) > 0;

export const waitForTrigger = (page: Page, id: string, timeout = 20000) =>
  page.waitForFunction(
    (i) => !!document.getElementById(i)?.shadowRoot?.querySelector('button.trigger'),
    { timeout },
    id,
  );

export const waitForNoTrigger = (page: Page, id: string, timeout = 20000) =>
  page.waitForFunction(
    (i) => !document.getElementById(i)?.shadowRoot?.querySelector('button.trigger'),
    { timeout },
    id,
  );

export const modalOpen = (page: Page, id: string) =>
  page.evaluate(
    (i) => !!(document.getElementById(i)?.shadowRoot?.querySelector('dialog.modal') as HTMLDialogElement | null)?.open,
    id,
  );

export const waitForModal = (page: Page, id: string, open = true, timeout = 20000) =>
  page.waitForFunction(
    (i, want) =>
      !!(document.getElementById(i)?.shadowRoot?.querySelector('dialog.modal') as HTMLDialogElement | null)?.open === want,
    { timeout },
    id,
    open,
  );

/** Opens the modal with a real click and waits until the editor inside it is ready. */
export async function openModal(page: Page, id: string): Promise<void> {
  await waitForTrigger(page, id);
  await (await trigger(page, id)).click();
  await waitForModal(page, id);
  await page.waitForFunction(
    (i) => !!document.getElementById(i)?.shadowRoot?.querySelector('dialog.modal .zbc form'),
    { timeout: 20000 },
    id,
  );
}

/** Gives the shopper a valid design (the photo is the only required field left). */
export async function makeValid(page: Page, id: string): Promise<void> {
  await upload(page, id, ASSET_PATHS.samplePhoto);
  await waitForCrop(page, id);
  await page.waitForFunction(
    (i) => {
      const save = document.getElementById(i)!.shadowRoot!.querySelector('dialog.modal button.primary') as HTMLButtonElement | null;
      return !!save && !save.disabled;
    },
    { timeout: 20000 },
    id,
  );
}

export const clickSave = (page: Page, id: string) =>
  page.evaluate(
    (i) => (document.getElementById(i)!.shadowRoot!.querySelector('dialog.modal button.primary') as HTMLButtonElement).click(),
    id,
  );

export const zbOf = async (page: Page, id: string, type?: string) =>
  (await host.zbEvents(page)).filter((e) => e.targetId === id && (!type || e.type === type));

/** `getComputedStyle` of the first match in the shadow root, for the properties asked for. */
export const computed = <K extends string>(page: Page, id: string, selector: string, properties: readonly K[]) =>
  page.evaluate(
    (i, s, props) => {
      const el = document.getElementById(i)!.shadowRoot!.querySelector(s) as HTMLElement;
      const style = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)]));
    },
    id,
    selector,
    [...properties],
  ) as Promise<Record<K, string>>;

export async function clickHandle(handle: ElementHandle<Element>): Promise<void> {
  await handle.click();
}

/** Counts requests for JS files the page makes, and lets a test split "before" from "after" a moment. */
export function recordScripts(page: Page) {
  const urls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\.js(\?|$)/.test(url)) urls.push(url);
  });
  return {
    urls,
    mark: () => urls.length,
    since: (mark: number) => urls.slice(mark),
  };
}

export const configRequests = (env: Environment) =>
  env.api.requests.filter((r) => /\/products\/[^/]+\/config/.test(r.url));

/** Waits for a computed style to settle on a value (the trigger eases colour changes over a moment). */
export const waitForStyle = (page: Page, id: string, selector: string, property: string, value: string, timeout = 5000) =>
  page.waitForFunction(
    (i, s, p, v) => getComputedStyle(document.getElementById(i)!.shadowRoot!.querySelector(s)!).getPropertyValue(p) === v,
    { timeout },
    id,
    selector,
    property,
    value,
  );
