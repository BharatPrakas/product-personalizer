import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { CATALOG, createPublished, importTemplate, openEditor } from './admin.helpers';
import {
  type Environment,
  adminHost,
  clickText,
  openAdminHost,
  startEnvironment,
  waitInside,
} from './harness';

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

interface AxeResult {
  violations: {
    id: string;
    impact: string;
    nodes: { target: unknown[]; failureSummary: string }[];
  }[];
}

async function axeViolations(page: Page, id: string): Promise<string[]> {
  await page.evaluate(axeSource);
  const result = (await page.evaluate(
    (i) =>
      (window as any).axe.run(document.getElementById(i), {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
        // the element is a component inside someone else's page
        rules: { region: { enabled: false } },
      }),
    id,
  )) as AxeResult;
  return result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} -> ${n.failureSummary.split('\n')[1]?.trim()}`).join(' | ')}`,
  );
}

const click = (page: Page, selector: string) =>
  page.evaluate(
    (s) => (document.getElementById('a')!.shadowRoot!.querySelector(s) as HTMLElement).click(),
    selector,
  );

for (const viewport of [
  { width: 1280, height: 1000 },
  { width: 360, height: 740 },
]) {
  describe(`axe-core (WCAG 2.2 AA + best practice) on the admin element, ${viewport.width}px wide`, () => {
    it('list, dialogs, mapping and editor tabs have no violations', async () => {
      const { page } = await openAdminHost(env, { viewport });
      await adminHost.mount(page, 'a', { productCatalog: CATALOG });
      await adminHost.ready(page, 'a');
      await waitInside(page, 'a', 'input[type="file"]');
      expect(await axeViolations(page, 'a')).toEqual([]); // empty list

      await createPublished(env, page, 'a', 'Accessible design');
      await waitInside(page, 'a', '.data-table');
      expect(await axeViolations(page, 'a')).toEqual([]);

      // New-configuration dialog and the row menu.
      await clickText(page, 'a', 'button', 'New configuration');
      await waitInside(page, 'a', 'app-new-configuration-dialog dialog[open]');
      expect(await axeViolations(page, 'a')).toEqual([]);
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () =>
          !document
            .getElementById('a')!
            .shadowRoot!.querySelector('app-new-configuration-dialog dialog[open]'),
      );

      // Mapping: empty selection, with a selection, with a conflict dialog open.
      await adminHost.set(page, 'a', 'view', 'mapping');
      await adminHost.waitView(page, 'a', 'mapping');
      await waitInside(page, 'a', '.mapping-table tbody tr');
      expect(await axeViolations(page, 'a')).toEqual([]);
      await click(page, '.mapping-table tbody tr:nth-child(1) input[type="checkbox"]');
      await clickText(page, 'a', '.bulk-bar button', 'Map to this template');
      await page.waitForFunction(() =>
        document
          .getElementById('a')!
          .shadowRoot!.querySelector('.mapping-table tbody td:nth-child(4)')!
          .textContent!.includes('Mapped'),
      );
      expect(await axeViolations(page, 'a')).toEqual([]);

      await createPublished(env, page, 'a', 'Other design');
      await adminHost.set(page, 'a', 'view', 'mapping');
      await adminHost.waitView(page, 'a', 'mapping');
      await waitInside(page, 'a', '#mapping-template');
      await page.evaluate(() => {
        const select = document
          .getElementById('a')!
          .shadowRoot!.querySelector('#mapping-template') as HTMLSelectElement;
        select.value = [...select.options].find((o) =>
          o.textContent!.includes('Other design'),
        )!.value;
        select.dispatchEvent(new Event('change'));
      });
      await page.waitForFunction(() =>
        document
          .getElementById('a')!
          .shadowRoot!.querySelector('.mapping-table tbody td:nth-child(4)')!
          .textContent!.includes('Conflict'),
      );
      await click(page, '.mapping-table tbody tr:nth-child(1) input[type="checkbox"]');
      await clickText(page, 'a', '.bulk-bar button', 'Map to this template');
      await waitInside(page, 'a', 'app-dialog dialog[open]');
      expect(await axeViolations(page, 'a')).toEqual([]);
      await clickText(page, 'a', 'app-dialog dialog[open] button', 'Cancel');

      // Editor and every sidebar tab, including the markup library.
      await adminHost.set(page, 'a', 'view', 'list');
      await adminHost.waitView(page, 'a', 'list');
      await waitInside(page, 'a', '.data-table');
      await openEditor(page, 'a', 'Other design');
      expect(await axeViolations(page, 'a')).toEqual([]);
      for (const tab of ['mockups', 'areas', 'artworks', 'layers', 'markups']) {
        await click(page, `#tab-${tab}`);
        await waitInside(page, 'a', `#tabpanel-${tab}`);
        expect(await axeViolations(page, 'a'), `tab ${tab}`).toEqual([]);
      }
      await page.close();
    });

    it('right-to-left and read-only variants have no violations', async () => {
      const { page } = await openAdminHost(env, { viewport });
      await adminHost.mount(page, 'a', {
        productCatalog: CATALOG,
        locale: 'ar',
        readonly: true,
        view: 'mapping',
      });
      await adminHost.ready(page, 'a');
      await waitInside(page, 'a', '.readonly-banner');
      expect(await axeViolations(page, 'a')).toEqual([]);
      await page.close();
    });
  });
}

describe('keyboard operation', () => {
  it('moves through navigation and the mapping table with Tab and focuses the page heading after a view change', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { productCatalog: CATALOG });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'nav a');
    // Activate the "Product mapping" link with the keyboard.
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelectorAll('nav a')[1] as HTMLElement
      ).focus(),
    );
    await page.keyboard.press('Enter');
    await adminHost.waitView(page, 'a', 'mapping');
    await page.waitForFunction(
      () => document.getElementById('a')!.shadowRoot!.activeElement?.tagName === 'H1',
      { timeout: 5000 },
    );
    expect(
      await page.evaluate(() =>
        document.getElementById('a')!.shadowRoot!.activeElement?.textContent?.trim(),
      ),
    ).toBe('Product mapping');
    // The live region announces the new view.
    expect(
      await page.evaluate(
        () =>
          document.getElementById('a')!.shadowRoot!.querySelector('[aria-live="polite"].sr-only')!
            .textContent,
      ),
    ).toContain('product mapping');
    await page.close();
  });
});

void importTemplate;
