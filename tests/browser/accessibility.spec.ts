import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import {
  ASSET_PATHS,
  type Environment,
  NESTED,
  clickButton,
  host,
  insideAll,
  insideCount,
  insideText,
  openHost,
  startEnvironment,
  typeText,
  upload,
} from './harness';
import {
  fillTote,
  waitForChange,
  waitForCrop,
  waitForSaveEnabled,
} from './personalization.helpers';

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
const TSHIRT = `${NESTED}/data/tshirt-text.json`;
const POSTER = `${NESTED}/data/poster-artwork.json`;

interface AxeResult {
  violations: {
    id: string;
    impact: string;
    help: string;
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
        // the element is a landmark-less component inside someone else's page
        rules: { region: { enabled: false } },
      }),
    id,
  )) as AxeResult;
  return result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} -> ${n.failureSummary.split('\n')[1]?.trim()}`).join(' | ')}`,
  );
}

describe('axe-core (WCAG 2.2 AA + best practice) on the element', () => {
  const viewports = [
    { width: 1280, height: 1000 },
    { width: 360, height: 740 },
  ];

  for (const viewport of viewports) {
    describe(`${viewport.width}px wide`, () => {
      it('initial state of every sample template has no violations', async () => {
        for (const url of [TOTE, TSHIRT, POSTER]) {
          const { page } = await openHost(env, { viewport });
          await host.mount(page, 'a', { configUrl: url });
          await host.waitStatus(page, 'a', 'ready');
          expect(await axeViolations(page, 'a'), url).toEqual([]);
          await page.close();
        }
      });

      it('with a photo, crop editor, artwork and a visible reset confirmation', async () => {
        const { page } = await openHost(env, { viewport });
        await host.mount(page, 'a', { configUrl: TOTE });
        await host.waitStatus(page, 'a', 'ready');
        await fillTote(page, env, 'a', { name: 'Alex', artwork: 'Star', save: false });
        await waitForSaveEnabled(page, 'a');
        expect(await axeViolations(page, 'a')).toEqual([]);
        await clickButton(page, 'a', 'Reset');
        expect(await insideCount(page, 'a', '.confirm')).toBe(1);
        expect(await axeViolations(page, 'a')).toEqual([]);
        await page.close();
      });

      it('with field errors, a warning and the awaiting-host state', async () => {
        const { page } = await openHost(env, { viewport });
        await host.mount(page, 'a', { configUrl: TOTE });
        await host.waitStatus(page, 'a', 'ready');
        await typeText(page, 'a', 'input[type="text"]', 'x'.repeat(30));
        await upload(page, 'a', ASSET_PATHS.samplePhoto);
        await waitForCrop(page, 'a');
        await page.evaluate(() => {
          const range = document
            .getElementById('a')!
            .shadowRoot!.querySelector('input[type="range"]') as HTMLInputElement;
          range.value = '2.2'; // 545 px over 5.33 in = 102 DPI: warning, not an error
          range.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() =>
          document.getElementById('a')!.shadowRoot!.querySelector('.warning'),
        );
        expect(await insideCount(page, 'a', '.error')).toBeGreaterThan(0);
        expect(await axeViolations(page, 'a')).toEqual([]);

        await typeText(page, 'a', 'input[type="text"]', 'Alex');
        await waitForSaveEnabled(page, 'a');
        await clickButton(page, 'a', 'Save customization');
        await host.waitSaveState(page, 'a', 'awaiting-host');
        expect(await axeViolations(page, 'a')).toEqual([]);
        await page.close();
      });

      it('invalid-configuration and missing-asset panels', async () => {
        const { page } = await openHost(env, { viewport });
        await host.mount(page, 'bad', { configUrl: `${NESTED}/data/does-not-exist.json` });
        await host.waitStatus(page, 'bad', 'invalid-config');
        expect(await axeViolations(page, 'bad')).toEqual([]);
        await page.close();
      });
    });
  }
});

describe('A18: responsive layout', () => {
  const interactive =
    'button, input[type="text"], input[type="range"], select, label.card, .swatch, label.file-btn, canvas.crop-canvas';

  async function layoutReport(page: Page, id: string) {
    return page.evaluate(
      (i, selector) => {
        const el = document.getElementById(i)!;
        const root = el.shadowRoot!;
        const rect = (s: string) => root.querySelector(s)!.getBoundingClientRect();
        const tooSmall = [...root.querySelectorAll(selector)]
          .map((node) => ({ node, r: node.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0 && (r.height < 43.5 || r.width < 43.5))
          .map(
            ({ node, r }) =>
              `${node.tagName.toLowerCase()}.${(node as HTMLElement).className} ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        const hostRect = el.getBoundingClientRect();
        const clipped = [...root.querySelectorAll('*')]
          .filter(
            (node) => !node.classList.contains('sr-only') && !node.classList.contains('file-input'),
          )
          .filter((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && (r.right > hostRect.right + 1 || r.left < hostRect.left - 1);
          })
          .map((node) => `${node.tagName.toLowerCase()}.${(node as HTMLElement).className}`);
        return {
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          hostOverflow: el.scrollWidth > el.clientWidth,
          columns: getComputedStyle(root.querySelector('.layout')!).gridTemplateColumns.split(' ')
            .length,
          previewAboveControls: rect('.preview-col').bottom <= rect('.controls-col').top + 1,
          previewLeftOfControls: rect('.preview-col').right <= rect('.controls-col').left + 1,
          tooSmall,
          clipped,
        };
      },
      id,
      interactive,
    );
  }

  it('360 px: single column, preview above controls, no horizontal overflow, 44 px targets, Save reachable and uncovered', async () => {
    const { page } = await openHost(env, { viewport: { width: 360, height: 740 } });
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    await fillTote(page, env, 'a', { name: 'Alex', artwork: 'Sun', save: false });
    await waitForSaveEnabled(page, 'a');
    const report = await layoutReport(page, 'a');
    expect(report.pageOverflow).toBe(false);
    expect(report.hostOverflow).toBe(false);
    expect(report.columns).toBe(1);
    expect(report.previewAboveControls).toBe(true);
    expect(report.tooSmall).toEqual([]);
    expect(report.clipped).toEqual([]);
    // Save is reachable by scrolling, and nothing is laid over it (no fixed/sticky bar covering controls)
    const covered = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const button = root.querySelector('button.primary') as HTMLElement;
      button.scrollIntoView({ block: 'center' });
      const r = button.getBoundingClientRect();
      const top = document
        .getElementById('a')!
        .shadowRoot!.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        reached: top === button || button.contains(top),
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
      };
    });
    expect(covered).toEqual({ reached: true, inViewport: true });
    const positioned = await page.evaluate(() =>
      [...document.getElementById('a')!.shadowRoot!.querySelectorAll('*')]
        .filter(
          (e) => ['sticky', 'fixed'].includes(getComputedStyle(e).position) && e.tagName !== 'DIV',
        )
        .map((e) => e.className),
    );
    expect(positioned).toEqual([]);
    await page.close();
  });

  it('1280 px: clean two-column layout with the preview on the left', async () => {
    const { page } = await openHost(env, { viewport: { width: 1280, height: 900 } });
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    const report = await layoutReport(page, 'a');
    expect(report.columns).toBe(2);
    expect(report.previewLeftOfControls).toBe(true);
    expect(report.pageOverflow).toBe(false);
    expect(report.clipped).toEqual([]);
    await page.close();
  });

  it.each([
    ['320 px (WCAG reflow)', { width: 320, height: 640 }],
    [
      '200% zoom of a 1280 px window (640 css px)',
      { width: 640, height: 450, deviceScaleFactor: 2 },
    ],
    [
      '200% zoom of a 720 px window (360 css px)',
      { width: 360, height: 370, deviceScaleFactor: 2 },
    ],
  ])('%s: nothing is clipped or overflows', async (_label, viewport) => {
    const { page } = await openHost(env, { viewport });
    for (const [id, url] of [
      ['a', TOTE],
      ['b', TSHIRT],
      ['c', POSTER],
    ] as const) {
      await host.mount(page, id, { configUrl: url });
      await host.waitStatus(page, id, 'ready');
    }
    for (const id of ['a', 'b', 'c']) {
      const report = await layoutReport(page, id);
      expect(report.pageOverflow, id).toBe(false);
      expect(report.hostOverflow, id).toBe(false);
      expect(report.clipped, id).toEqual([]);
    }
    await page.close();
  });

  it('shows the price at 360 px without any horizontal scroll inside the widget', async () => {
    const { page } = await openHost(env, { viewport: { width: 360, height: 740 } });
    await host.mount(page, 'c', { configUrl: POSTER });
    await host.waitStatus(page, 'c', 'ready');
    expect(await insideText(page, 'c', '.price-total')).toBe('₹819.00');
    expect(
      await page.evaluate(
        () =>
          document.getElementById('c')!.shadowRoot!.querySelector('.zbc')!.scrollWidth <=
          document.getElementById('c')!.shadowRoot!.querySelector('.zbc')!.clientWidth,
      ),
    ).toBe(true);
    await page.close();
  });
});

describe('keyboard operation and focus', () => {
  const focusedDescription = (page: Page, id: string) =>
    page.evaluate((i) => {
      const active = document.getElementById(i)!.shadowRoot!.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      const wrapper = active.closest('label') as HTMLElement | null;
      const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
      const visible =
        style.outlineStyle !== 'none' || (wrapperStyle && wrapperStyle.outlineStyle !== 'none');
      return {
        tag: active.tagName.toLowerCase(),
        type: (active as HTMLInputElement).type ?? '',
        text: (
          active.getAttribute('aria-label') ??
          (active as HTMLInputElement).labels?.[0]?.textContent ??
          active.textContent ??
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40),
        visibleFocus: !!visible,
      };
    }, id);

  it('every control is reachable with Tab and shows a visible focus indicator', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    // Fill without moving keyboard focus, so Tab starts from the top of the page like a real visitor's.
    await page.evaluate(() => {
      const input = document
        .getElementById('a')!
        .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
      input.value = 'Alex';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await upload(page, 'a', ASSET_PATHS.samplePhoto);
    await waitForCrop(page, 'a');
    await waitForSaveEnabled(page, 'a');

    const seen: NonNullable<Awaited<ReturnType<typeof focusedDescription>>>[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const current = await focusedDescription(page, 'a');
      if (!current) break;
      seen.push(current);
    }
    const labels = seen.map((s) => `${s.tag}:${s.type}:${s.text}`);
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^input:text:/),
        expect.stringMatching(/^select:/),
        expect.stringMatching(/^input:radio:/),
        expect.stringMatching(/^canvas::/),
        expect.stringMatching(/^input:range:/),
        'button:button:Move photo up',
        'button:button:Move photo down',
        'button:button:Move photo left',
        'button:button:Move photo right',
        'button:button:Reset crop',
        'button:button:Remove photo',
        'button:button:Save customization',
        'button:button:Reset',
      ]),
    );
    expect(seen.filter((s) => !s.visibleFocus).map((s) => `${s.tag}:${s.text}`)).toEqual([]);
    await page.close();
  });

  it('a whole customization can be completed and saved without a mouse', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');

    await page.keyboard.press('Tab'); // name
    await page.keyboard.type('Kay');
    await page.keyboard.press('Tab'); // font
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab'); // colour group
    await page.keyboard.press('ArrowRight');
    await waitForChange(
      page,
      'a',
      `(d) => d.draft.values.name.text === 'Kay' && d.draft.values.name.fontId === 'serif' && d.draft.values.name.color === '#111827'`,
    );

    await upload(page, 'a', ASSET_PATHS.samplePhoto); // the OS file dialog itself is outside the page's control
    await waitForCrop(page, 'a');
    const tabUntil = async (
      predicate: (s: NonNullable<Awaited<ReturnType<typeof focusedDescription>>>) => boolean,
    ) => {
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        const d = await focusedDescription(page, 'a');
        if (d && predicate(d)) return d;
      }
      throw new Error('control not reachable by keyboard');
    };
    await tabUntil((s) => s.tag === 'canvas');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');
    await waitForChange(page, 'a', `(d) => d.draft.values.photo.crop[2] < 2/3`);

    await tabUntil((s) => s.tag === 'input' && s.type === 'radio' && s.text.includes('None')); // artwork group (checked: none)
    await page.keyboard.press('ArrowDown');
    await waitForChange(page, 'a', `(d) => d.draft.values.motif.choiceId === 'star'`);

    await tabUntil((s) => s.text === 'Save customization');
    await page.keyboard.press('Enter');
    await host.waitSaveState(page, 'a', 'awaiting-host');
    expect(await host.events(page, 'a', 'customizer-save')).toHaveLength(1);
    await page.close();
  });

  it('announces errors and status through polite live regions and associates them with their inputs', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    await typeText(page, 'a', 'input[type="text"]', 'x'.repeat(30));
    await waitForChange(page, 'a', `(d) => d.errors.some((e) => e.code === 'too-long')`);
    const wiring = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const input = root.querySelector('input[type="text"]') as HTMLInputElement;
      const described = input
        .getAttribute('aria-describedby')!
        .split(' ')
        .map((id) => root.getElementById(id));
      return {
        invalid: input.getAttribute('aria-invalid'),
        required: input.getAttribute('aria-required'),
        describedByResolves: described.every(Boolean),
        errorRegionLive: described.some(
          (el) =>
            el?.getAttribute('aria-live') === 'polite' && el.textContent!.includes('at most 24'),
        ),
        labelled: root
          .querySelector(`label[for="${input.id}"]`)
          ?.textContent?.includes('Your name'),
        statusRegion: root.querySelector('.status')?.getAttribute('role'),
      };
    });
    expect(wiring).toEqual({
      invalid: 'true',
      required: 'true',
      describedByResolves: true,
      errorRegionLive: true,
      labelled: true,
      statusRegion: 'status',
    });
    await page.close();
  });

  it('conveys errors with text and an icon shape, not colour alone', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    await typeText(page, 'a', 'input[type="text"]', 'x'.repeat(30));
    await page.waitForFunction(() =>
      document.getElementById('a')!.shadowRoot!.querySelector('.field .error'),
    );
    expect(await insideAll(page, 'a', '.field .error-mark')).toEqual(['!']);
    expect(await insideText(page, 'a', '.field .error')).toContain('Use at most 24 characters');
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(
            document.getElementById('a')!.shadowRoot!.querySelector('input[type="text"]')!,
          ).borderTopWidth,
      ),
    ).toBe('2px'); // thicker border as well as a colour change
    await page.close();
  });
});

describe('A19 / A20: display price and the plain HTML demo', () => {
  it('shows ₹599.00 as an indicative, host-supplied price and offers no cart or payment action', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.waitStatus(page, 'a', 'ready');
    expect(await insideText(page, 'a', '.price-total')).toBe('₹599.00');
    const note = await insideText(page, 'a', '.price-note');
    expect(note).toContain('₹499.00 + ₹100.00 personalization');
    expect(note).toMatch(/supplied by the store/i);
    expect(note).toMatch(/confirmed at checkout/i);
    const buttons = await insideAll(page, 'a', 'button');
    expect(buttons.filter((b) => /cart|buy|checkout|pay/i.test(b))).toEqual([]);
    await page.close();
  });

  it('the shipped integration demo works end to end with no Angular on the page and makes no false persistence claim', async () => {
    const page = await env.browser.newPage();
    await page.setViewport({ width: 1280, height: 1100 });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${env.elementBase}/integration-demo/storefront.html`);
    await page.waitForSelector('zb-product-customizer[data-status="ready"]');
    // Dev builds publish Angular's `ng` debug global; the contract is that no Zone.js patch is installed.
    expect(await page.evaluate(() => typeof (window as any).Zone)).toBe('undefined');
    expect(await page.evaluate(() => document.body.textContent)).toMatch(/in memory only/);

    const jsonButton = () =>
      page.$eval('[data-role="json"]', (b) => (b as HTMLButtonElement).disabled);
    expect(await jsonButton()).toBe(true);

    await page.evaluate(() => {
      (window as any).__el = document.querySelector('zb-product-customizer');
    });
    const name = await page.evaluateHandle(() =>
      (window as any).__el.shadowRoot.querySelector('input[type="text"]'),
    );
    await (name.asElement() as any).type('Demo Name');
    const file = await page.evaluateHandle(() =>
      (window as any).__el.shadowRoot.querySelector('input[type="file"]'),
    );
    await (file.asElement() as any).uploadFile(ASSET_PATHS.samplePhoto);
    await page.waitForFunction(() =>
      (window as any).__el.shadowRoot.querySelector('canvas.crop-canvas'),
    );
    await page.waitForFunction(
      () => !(window as any).__el.shadowRoot.querySelector('button.primary').disabled,
    );
    await page.evaluate(() =>
      (window as any).__el.shadowRoot.querySelector('button.primary').click(),
    );
    await page.waitForFunction(
      () => (window as any).__el.getAttribute('data-save-state') === 'saved',
      { timeout: 15000 },
    );
    expect(
      await page.evaluate(
        () => (window as any).__el.shadowRoot.querySelector('.status').textContent,
      ),
    ).toContain('Prepared in demo. Nothing was sent to a server.');
    expect(await jsonButton()).toBe(false);

    // restoring creates a fresh element from the in-memory save
    await page.click('[data-role="restore"]');
    await page.waitForFunction(
      () =>
        document.querySelector('zb-product-customizer')!.getAttribute('data-status') === 'ready' &&
        document.querySelectorAll('zb-product-customizer').length === 1,
    );
    await page.waitForFunction(
      () =>
        (
          document
            .querySelector('zb-product-customizer')!
            .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement | null
        )?.value === 'Demo Name',
    );
    expect(await page.evaluate(() => document.getElementById('log')!.textContent)).toContain(
      '#i1 ready',
    );

    // a second, independent instance
    await page.click('#add');
    await page.waitForFunction(
      () => document.querySelectorAll('zb-product-customizer[data-status="ready"]').length === 2,
    );
    expect(pageErrors).toEqual([]);
    await page.close();
  });
});
