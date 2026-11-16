import type { Page } from 'puppeteer-core';
import { type Environment, adminHost, openAdminHost, startEnvironment, waitInside } from './harness';
import { CATALOG, createPublished, importTemplate, openEditor } from './admin.helpers';

/**
 * Layout guarantees of the admin element: no sideways scrolling at phone, tablet and desktop widths,
 * menus that open at their trigger wherever the host places the element, and no styles leaking
 * into the host page from any view.
 */

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

const WIDTHS = [360, 390, 768, 1024, 1280, 1440];

/** Sideways overflow of the page and of the element's own scroller at the current viewport. */
function overflow(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById('a')!.shadowRoot!;
    const scroller = root.querySelector('.zb-admin') as HTMLElement;
    const wraps = [...root.querySelectorAll('.table-wrap')] as HTMLElement[];
    return {
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      element: scroller.scrollWidth > scroller.clientWidth + 1,
      tables: wraps.some((w) => w.scrollWidth > w.clientWidth + 1),
    };
  });
}

async function noSidewaysScroll(page: Page, view: string) {
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await overflow(page), `${view} at ${width}px`).toEqual({
      page: false,
      element: false,
      tables: false,
    });
  }
}

describe('admin layout', () => {
  it('list, mapping and editor never scroll sideways from 360 px to 1440 px', async () => {
    const { page } = await openAdminHost(env);
    await adminHost.mount(page, 'a', { productCatalog: CATALOG });
    await adminHost.ready(page, 'a');
    await createPublished(env, page, 'a', 'Layout tee');
    await waitInside(page, 'a', '.data-table');
    await noSidewaysScroll(page, 'list');

    await adminHost.set(page, 'a', 'view', 'mapping');
    await adminHost.waitView(page, 'a', 'mapping');
    await waitInside(page, 'a', '.mapping-table tbody tr');
    await noSidewaysScroll(page, 'mapping');

    await adminHost.set(page, 'a', 'view', 'list');
    await adminHost.waitView(page, 'a', 'list');
    await openEditor(page, 'a', 'Layout tee');
    await noSidewaysScroll(page, 'editor');
    await page.close();
  });

  it('opens row menus at their trigger when the element sits away from the page corner', async () => {
    const { page } = await openAdminHost(env, { viewport: { width: 1280, height: 900 } });
    // A host shell with a top bar and a side menu: the element's box starts at (200, ~190).
    await page.addStyleTag({ content: 'body { margin: 0; padding: 120px 0 0 200px; }' });
    await adminHost.mount(page, 'a');
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'input[type="file"]');
    await importTemplate(env, page, 'a', 'Offset menu');
    await page.evaluate(() =>
      (
        document
          .getElementById('a')!
          .shadowRoot!.querySelector('tbody button[aria-haspopup="menu"]') as HTMLElement
      ).click(),
    );
    await waitInside(page, 'a', '.menu');
    const placement = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const trigger = root.querySelector('tbody button[aria-haspopup="menu"]')!.getBoundingClientRect();
      const menu = root.querySelector('.menu')!.getBoundingClientRect();
      return {
        gapBelowTrigger: Math.round(menu.top - trigger.bottom),
        rightEdgeOffset: Math.round(menu.right - trigger.right),
        insideWindow: menu.left >= 0 && menu.right <= window.innerWidth,
      };
    });
    expect(placement).toEqual({ gapBelowTrigger: 4, rightEdgeOffset: 0, insideWindow: true });
    await page.close();
  });

  it('the editor pasteboard shows a dot grid that moves with panning', async () => {
    const { page } = await openAdminHost(env, { viewport: { width: 1280, height: 900 } });
    await adminHost.mount(page, 'a');
    await adminHost.ready(page, 'a');
    await waitInside(page, 'a', 'input[type="file"]');
    await importTemplate(env, page, 'a', 'Dot grid');
    await openEditor(page, 'a', 'Dot grid');
    await waitInside(page, 'a', 'app-stage .stage-overlay');
    const grid = () =>
      page.evaluate(() => {
        const stage = document
          .getElementById('a')!
          .shadowRoot!.querySelector('app-stage .stage') as HTMLElement;
        const style = getComputedStyle(stage);
        return { x: parseFloat(style.getPropertyValue('--grid-x')), image: style.backgroundImage };
      });
    const before = await grid();
    expect(before.image).toContain('radial-gradient');
    // A sideways wheel pans the view 7 px to the left; the dots follow (the offset wraps every 20 px).
    await page.evaluate(() => {
      const overlay = document
        .getElementById('a')!
        .shadowRoot!.querySelector('app-stage .stage-overlay')!;
      const r = overlay.getBoundingClientRect();
      overlay.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 7,
          deltaY: 0,
          clientX: r.left + 40,
          clientY: r.top + 40,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const after = await grid();
    expect((((before.x - 7 - after.x) % 20) + 20) % 20).toBeCloseTo(0, 1);
    await page.close();
  });

  it('the Orders view adds no styles to the host page', async () => {
    const { page } = await openAdminHost(env);
    const count = () =>
      page.evaluate(() => document.head.querySelectorAll('style, link[rel="stylesheet"]').length);
    const before = await count();
    await adminHost.mount(page, 'a', { view: 'orders' });
    await adminHost.ready(page, 'a');
    await adminHost.waitView(page, 'a', 'orders');
    await waitInside(page, 'a', 'app-orders-page app-empty-state');
    expect(await count()).toBe(before); // every style lives in the shadow root
    await page.close();
  });
});
