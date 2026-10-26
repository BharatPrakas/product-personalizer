import type { Page } from 'puppeteer-core';
import {
  type Environment,
  adminHost,
  clickText,
  insideCount,
  insideText,
  openAdminHost,
  startEnvironment,
  waitInside,
} from './harness';
import { CATALOG, createPublished, importTemplate, names, openEditor } from './admin.helpers';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

describe('templates, publishing and mapping', () => {
  it('import, publish and map a template to products; conflicts, reassignment, unmapping and archiving', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { productCatalog: CATALOG });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'input[type="file"]');

    await createPublished(env, page, 'a', 'Tee design');
    const published = await adminHost.events(page, 'a', 'config-published');
    expect(published[0].detail).toMatchObject({ name: 'Tee design', version: 1 });
    expect((await adminHost.events(page, 'a', 'config-saved')).length).toBeGreaterThan(0);

    // ---- map it
    await adminHost.set(page, 'a', 'view', 'mapping');
    await adminHost.waitView(page, 'a', 'mapping');
    await waitInside(page, 'a', '.mapping-table tbody tr');
    expect(await names(page, 'a', '.mapping-table tbody .row-title')).toEqual([
      'Classic tee',
      'Ceramic mug',
      'Baseball cap',
    ]);
    expect(await names(page, 'a', '.mapping-table tbody td:nth-child(4)')).toEqual([
      'Unmapped',
      'Unmapped',
      'Unmapped',
    ]);

    await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      (
        root.querySelector(
          '.mapping-table tbody tr:nth-child(1) input[type="checkbox"]',
        ) as HTMLElement
      ).click();
      (
        root.querySelector(
          '.mapping-table tbody tr:nth-child(2) input[type="checkbox"]',
        ) as HTMLElement
      ).click();
    });
    expect(await insideText(page, 'a', '.bulk-bar')).toContain('2 selected');
    await clickText(page, 'a', '.bulk-bar button', 'Map to this template');
    await page.waitForFunction(
      (i) => (window as any).adminHost.events(i, 'mapping-changed').length > 0,
      { timeout: 10000 },
      'a',
    );
    const changed = (await adminHost.events(page, 'a', 'mapping-changed')).at(-1)!;
    expect(changed.detail.action).toBe('bulk');
    expect(changed.detail.mappings.map((m: any) => `${m.scope}:${m.externalId}`).sort()).toEqual([
      'product:prod-mug',
      'product:prod-tee',
    ]);
    expect(changed.detail.mappings[0]).toMatchObject({ storeId: 'local' });
    await page.waitForFunction(
      (i) =>
        [
          ...document
            .getElementById(i)!
            .shadowRoot!.querySelectorAll('.mapping-table tbody td:nth-child(4)'),
        ]
          .slice(0, 2)
          .every((c) => c.textContent!.includes('Mapped')),
      { timeout: 10000 },
      'a',
    );
    expect(await names(page, 'a', '.current-item')).toHaveLength(2);

    // ---- a second template and a conflict
    await createPublished(env, page, 'a', 'Second design');
    await adminHost.set(page, 'a', 'view', 'mapping');
    await adminHost.waitView(page, 'a', 'mapping');
    await waitInside(page, 'a', '#mapping-template');
    await page.evaluate(() => {
      const select = document
        .getElementById('a')!
        .shadowRoot!.querySelector('#mapping-template') as HTMLSelectElement;
      const option = [...select.options].find((o) => o.textContent!.includes('Second design'))!;
      select.value = option.value;
      select.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(
      (i) =>
        [
          ...document
            .getElementById(i)!
            .shadowRoot!.querySelectorAll('.mapping-table tbody td:nth-child(4)'),
        ].some((c) => c.textContent!.includes('Conflict')),
      { timeout: 10000 },
      'a',
    );
    expect(await insideText(page, 'a', '.mapping-table tbody tr:nth-child(1)')).toContain(
      'Mapped to “Tee design”',
    );
    // Map the conflicting mug plus the free cap: the cap is mapped, the mug asks for confirmation.
    await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      (
        root.querySelector(
          '.mapping-table tbody tr:nth-child(2) input[type="checkbox"]',
        ) as HTMLElement
      ).click();
      (
        root.querySelector(
          '.mapping-table tbody tr:nth-child(3) input[type="checkbox"]',
        ) as HTMLElement
      ).click();
    });
    await clickText(page, 'a', '.bulk-bar button', 'Map to this template');
    await waitInside(page, 'a', 'app-dialog dialog[open]');
    expect(await insideText(page, 'a', 'app-dialog dialog[open]')).toContain(
      'Ceramic mug → Tee design',
    );
    expect(await adminHost.events(page, 'a', 'mapping-changed')).toHaveLength(2); // the cap only so far
    await clickText(page, 'a', 'app-dialog dialog[open] button', 'Reassign');
    await page.waitForFunction(
      (i) => (window as any).adminHost.events(i, 'mapping-changed').length === 3,
      { timeout: 10000 },
      'a',
    );
    const moved = (await adminHost.events(page, 'a', 'mapping-changed')).at(-1)!.detail;
    expect(moved.mappings.map((m: any) => m.externalId)).toEqual(['prod-mug']);

    // ---- unmap one
    await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const row = [...root.querySelectorAll('.mapping-table tbody tr')].find((r) =>
        r.textContent!.includes('Baseball cap'),
      )!;
      (
        [...row.querySelectorAll('button')].find((b) =>
          b.textContent!.includes('Unmap'),
        ) as HTMLElement
      ).click();
    });
    await page.waitForFunction(
      (i) => (window as any).adminHost.events(i, 'mapping-changed').length === 4,
      { timeout: 10000 },
      'a',
    );
    expect(
      (await adminHost.events(page, 'a', 'mapping-changed')).at(-1)!.detail.deletedIds,
    ).toHaveLength(1);

    // ---- archiving warns about mappings
    await adminHost.set(page, 'a', 'view', 'list');
    await adminHost.waitView(page, 'a', 'list');
    await waitInside(page, 'a', '.data-table');
    await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const row = [...root.querySelectorAll('.data-table tbody tr')].find((r) =>
        r.textContent!.includes('Second design'),
      )!;
      (row.querySelector('app-menu button[aria-haspopup]') as HTMLElement).click();
    });
    await waitInside(page, 'a', '.menu');
    await clickText(page, 'a', '.menu .menu-item', 'Archive');
    await waitInside(page, 'a', 'app-confirm-host dialog[open]');
    expect(await insideText(page, 'a', 'app-confirm-host dialog[open]')).toContain(
      'Mappings pointing at this template: 1',
    );
    await page.evaluate((i) => {
      const dialog = document
        .getElementById(i)!
        .shadowRoot!.querySelector('app-confirm-host dialog[open]')!;
      (
        [...dialog.querySelectorAll('button')].find(
          (b) => b.textContent!.trim() === 'Archive',
        ) as HTMLElement
      ).click();
    }, 'a');
    await page.waitForFunction(
      (i) => (window as any).adminHost.events(i, 'config-archived').length > 0,
      { timeout: 10000 },
      'a',
    );
    expect((await adminHost.events(page, 'a', 'config-archived'))[0].detail).toMatchObject({
      name: 'Second design',
      archived: true,
      affectedMappings: 1,
    });
    await page.close();
  });

  it('persists templates and mappings across page loads (browser storage)', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { productCatalog: CATALOG, view: 'mapping' });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', '.mapping-table tbody tr');
    expect(await names(page, 'a', '.current-item').then((x) => x.length)).toBeGreaterThan(0);
    await page.close();
  });
});

describe('read-only', () => {
  it('disables every control that changes data', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { productCatalog: CATALOG, readonly: true });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', '.data-table');
    expect(await insideText(page, 'a', '.readonly-banner')).toContain('Read-only');
    const disabled = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const create = [...root.querySelectorAll('button')].find((b) =>
        b.textContent!.includes('New configuration'),
      ) as HTMLButtonElement;
      return create.disabled;
    });
    expect(disabled).toBe(true);
    await adminHost.set(page, 'a', 'view', 'mapping');
    await adminHost.waitView(page, 'a', 'mapping');
    await waitInside(page, 'a', '.mapping-table tbody tr');
    expect(
      await page.evaluate(() => {
        const root = document.getElementById('a')!.shadowRoot!;
        return [...root.querySelectorAll('.mapping-table tbody button, .bulk-bar button')].every(
          (b) => (b as HTMLButtonElement).disabled,
        );
      }),
    ).toBe(true);
    // Opening a template in a read-only admin shows the customer preview, not the editor.
    await adminHost.set(page, 'a', 'view', 'list');
    await adminHost.waitView(page, 'a', 'list');
    await waitInside(page, 'a', 'a.row-title');
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('a.row-title') as HTMLElement
      ).click(),
    );
    await adminHost.waitView(page, 'a', 'preview');
    expect(await insideCount(page, 'a', '.editor')).toBe(0);
    await page.close();
  });
});

describe('markup library', () => {
  const rows = (page: Page, selector: string) => names(page, 'a', selector);

  it('saves an area and an artwork as markups and inserts them into a template (copy-on-insert)', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { productCatalog: CATALOG });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'input[type="file"]');
    await importTemplate(env, page, 'a', 'Markup source');
    await openEditor(page, 'a', 'Markup source');

    const openMenuOf = async (rowText: string) => {
      await page.evaluate((text) => {
        const root = document.getElementById('a')!.shadowRoot!;
        const row = [...root.querySelectorAll('.tab-panel .list-row')].find((r) =>
          r.textContent!.includes(text),
        )!;
        (row.querySelector('app-menu button[aria-haspopup]') as HTMLElement).click();
      }, rowText);
      await waitInside(page, 'a', '.menu');
    };
    const saveAs = async (name: string) => {
      await clickText(page, 'a', '.menu .menu-item', 'Save as markup');
      await waitInside(page, 'a', '#save-markup-form');
      await page.evaluate((n) => {
        const input = document
          .getElementById('a')!
          .shadowRoot!.querySelector('#save-markup-form input') as HTMLInputElement;
        input.value = n;
        input.dispatchEvent(new Event('input'));
      }, name);
      await page.evaluate(() =>
        (
          document
            .getElementById('a')!
            .shadowRoot!.querySelector('button[form="save-markup-form"]') as HTMLElement
        ).click(),
      );
    };

    // An area.
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-areas') as HTMLElement
      ).click(),
    );
    await waitInside(page, 'a', '#tabpanel-areas .list-row');
    const areaCount = (await rows(page, '#tabpanel-areas .list-row .list-row__title')).length;
    const areaName = (await rows(page, '#tabpanel-areas .list-row .list-row__title'))[0];
    await openMenuOf(areaName);
    await saveAs('Chest print');
    await page.waitForFunction(
      () =>
        !document
          .getElementById('a')!
          .shadowRoot!.querySelector('app-save-markup-dialog dialog[open]'),
      { timeout: 10000 },
    );

    // An artwork (the first one that has layers).
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-artworks') as HTMLElement
      ).click(),
    );
    await waitInside(page, 'a', '#tabpanel-artworks .list-row');
    await openMenuOf((await rows(page, '#tabpanel-artworks .list-row .list-row__title'))[0]);
    await saveAs('Photo + caption');
    await page.waitForFunction(
      () =>
        !document
          .getElementById('a')!
          .shadowRoot!.querySelector('app-save-markup-dialog dialog[open]'),
      { timeout: 10000 },
    );

    // A duplicate name in the same kind is refused with a message, not an element error.
    await openMenuOf((await rows(page, '#tabpanel-artworks .list-row .list-row__title'))[0]);
    await saveAs('photo + CAPTION');
    await page.waitForFunction(
      () => !!document.getElementById('a')!.shadowRoot!.querySelector('#save-markup-error'),
      { timeout: 5000 },
    );
    await page.evaluate(() =>
      (
        document
          .getElementById('a')!
          .shadowRoot!.querySelector(
            'app-save-markup-dialog button.btn:not(.btn--primary)',
          ) as HTMLElement
      ).click(),
    );
    expect(
      (await adminHost.events(page, 'a', 'admin-error')).filter(
        (e) => e.detail.code !== 'unexpected',
      ),
    ).toHaveLength(0);

    // The library lists both, searchable by kind.
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-markups') as HTMLElement
      ).click(),
    );
    await page.waitForFunction(
      () =>
        document.getElementById('a')!.shadowRoot!.querySelectorAll('#tabpanel-markups .list-row')
          .length === 1,
      { timeout: 10000 },
    );
    expect(await rows(page, '#tabpanel-markups .list-row__title')).toEqual(['Chest print']);

    // Insert the area: one more area, and the source area is unchanged.
    await clickText(page, 'a', '#tabpanel-markups .list-row button', 'Insert');
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-areas') as HTMLElement
      ).click(),
    );
    await page.waitForFunction(
      (n) =>
        document.getElementById('a')!.shadowRoot!.querySelectorAll('#tabpanel-areas .list-row')
          .length ===
        n + 1,
      { timeout: 10000 },
      areaCount,
    );
    const afterAreas = await rows(page, '#tabpanel-areas .list-row .list-row__title');
    expect(afterAreas).toContain('Chest print');
    expect(afterAreas.filter((n) => n === areaName)).toHaveLength(1);

    // Insert the artwork into the (now selected) new area.
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-markups') as HTMLElement
      ).click(),
    );
    await clickText(page, 'a', '#tabpanel-markups .segmented-item', 'Artworks');
    await page.waitForFunction(
      () =>
        [
          ...document
            .getElementById('a')!
            .shadowRoot!.querySelectorAll('#tabpanel-markups .list-row__title'),
        ].some((e) => e.textContent === 'Photo + caption'),
      { timeout: 10000 },
    );
    await clickText(page, 'a', '#tabpanel-markups .list-row button', 'Insert');
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-artworks') as HTMLElement
      ).click(),
    );
    await waitInside(page, 'a', '#tabpanel-artworks .list-group');
    const groups = await page.evaluate(() =>
      [
        ...document
          .getElementById('a')!
          .shadowRoot!.querySelectorAll('#tabpanel-artworks .list-group'),
      ].map((g) => ({
        area: g.querySelector('.list-group__title')!.textContent!.trim(),
        artworks: [...g.querySelectorAll('.list-row__title')].map((t) => t.textContent!.trim()),
      })),
    );
    expect(groups.find((g) => g.area === 'Chest print')!.artworks).toContain('Photo + caption');

    // The edit is a normal unsaved change of this template and saves like one.
    await clickText(page, 'a', '.editor-header button', 'Save draft');
    await page.waitForFunction(
      (i) => (window as any).adminHost.events(i, 'config-saved').length > 0,
      { timeout: 15000 },
      'a',
    );

    // Rename and delete from the library.
    await page.evaluate(() =>
      (
        document.getElementById('a')!.shadowRoot!.querySelector('#tab-markups') as HTMLElement
      ).click(),
    );
    await waitInside(page, 'a', '#tabpanel-markups .list-row');
    await page.evaluate(() => {
      const row = document
        .getElementById('a')!
        .shadowRoot!.querySelector('#tabpanel-markups .list-row')!;
      (row.querySelector('app-menu button[aria-haspopup]') as HTMLElement).click();
    });
    await waitInside(page, 'a', '.menu');
    await clickText(page, 'a', '.menu .menu-item', 'Delete');
    await waitInside(page, 'a', 'app-confirm-host dialog[open]');
    await page.evaluate(() => {
      const dialog = document
        .getElementById('a')!
        .shadowRoot!.querySelector('app-confirm-host dialog[open]')!;
      (
        [...dialog.querySelectorAll('button')].find(
          (b) => b.textContent!.trim() === 'Delete',
        ) as HTMLElement
      ).click();
    });
    await page.waitForFunction(
      () =>
        document.getElementById('a')!.shadowRoot!.querySelectorAll('#tabpanel-markups .list-row')
          .length === 0,
      { timeout: 10000 },
    );
    await page.close();
  });
});

describe('strict Content-Security-Policy host', () => {
  it('works with no inline script, no eval and nonce-only styles, including the editor', async () => {
    const { page, consoleErrors } = await openAdminHost(env, { page: 'admin-host-csp.html' });
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (v: string) => violations.push(v));
    await page.evaluate(() =>
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as any).reportViolation(`${e.violatedDirective}: ${e.blockedURI}`),
      ),
    );
    await adminHost.mount(page, 'a', { productCatalog: CATALOG });
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'input[type="file"]');

    const styled = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      return {
        primary: getComputedStyle(root.querySelector('.btn--primary')!).backgroundColor,
        nonces: [...root.querySelectorAll('style')].map((s) => s.nonce || s.getAttribute('nonce')),
      };
    });
    expect(styled.primary).toBe('rgb(79, 70, 229)');
    expect(styled.nonces.length).toBeGreaterThan(0);
    expect(styled.nonces.every((n) => n === 'zbtest123')).toBe(true);

    await importTemplate(env, page, 'a', 'CSP design');
    await openEditor(page, 'a', 'CSP design');
    expect(violations).toEqual([]);
    expect(consoleErrors.filter((m) => /Content Security Policy|Refused to/i.test(m))).toEqual([]);
    await page.close();
  });
});
