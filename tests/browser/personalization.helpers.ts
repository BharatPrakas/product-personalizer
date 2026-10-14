import type { Page } from 'puppeteer-core';
import {
  ASSET_PATHS,
  type Environment,
  clickButton,
  clickCard,
  insideAll,
  typeText,
  upload,
} from './harness';

export interface FillOptions {
  name?: string;
  photo?: string;
  artwork?: string;
  /** Click Save when everything is valid (default). */
  save?: boolean;
}

export const waitForCrop = (page: Page, id: string) =>
  page.waitForFunction(
    (i) => !!document.getElementById(i)!.shadowRoot!.querySelector('canvas.crop-canvas'),
    { timeout: 20000 },
    id,
  );

export const waitForSaveEnabled = (page: Page, id: string) =>
  page.waitForFunction(
    (i) =>
      !(
        document.getElementById(i)!.shadowRoot!.querySelector('button.primary') as HTMLButtonElement
      ).disabled,
    { timeout: 20000 },
    id,
  );

/** Fill the tote template (name, photo, optional artwork) and optionally save. */
export async function fillTote(
  page: Page,
  _env: Environment,
  id: string,
  options: FillOptions = {},
): Promise<void> {
  await typeText(page, id, 'input[type="text"]', options.name ?? 'Alex');
  await upload(page, id, options.photo ?? ASSET_PATHS.samplePhoto);
  await waitForCrop(page, id);
  if (options.artwork) await clickCard(page, id, options.artwork);
  if (options.save !== false) {
    await waitForSaveEnabled(page, id);
    await clickButton(page, id, 'Save customization');
  }
}

export const latestChange = async <T = any>(page: Page, id: string): Promise<T> => {
  const events = await page.evaluate(
    (i) => (window as any).testHost.events(i, 'customizer-change'),
    id,
  );
  return events.at(-1).detail as T;
};

/** Wait until the latest `customizer-change` satisfies `predicate` (evaluated in the page as source text). */
export const waitForChange = (page: Page, id: string, predicate: string) =>
  page.waitForFunction(
    (i, source) => {
      const events = (window as any).testHost.events(i, 'customizer-change');
      return events.length > 0 && new Function('d', `return (${source})(d)`)(events.at(-1).detail);
    },
    { timeout: 10000 },
    id,
    predicate,
  );

export const blockerList = (page: Page, id: string) => insideAll(page, id, '.blockers li');
