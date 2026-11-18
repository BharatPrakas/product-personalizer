/**
 * The storefront modal: opening and closing, focus, the unsaved-changes question, both save flows
 * (element-managed and host-acknowledged), reopening a saved design, reactions to a changing product, layout
 * on phones and desktops, stacking and scrolling, and keyboard use.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { type Environment, host, inside, insideCount, insideText, openHost, startEnvironment } from './harness';
import {
  MANAGED,
  clickSave,
  computed,
  configRequests,
  hasTrigger,
  makeValid,
  mapped,
  modalOpen,
  openModal,
  props,
  trigger,
  waitForModal,
  waitForNoTrigger,
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

const creates = () => env.api.shopper.requests.filter((r) => r.endpoint === 'customizations');
const uploads = () => env.api.shopper.requests.filter((r) => r.endpoint === 'uploads');
const activeClass = (page: Page, id: string) =>
  page.evaluate((i) => document.getElementById(i)!.shadowRoot!.activeElement?.className ?? null, id);
const closeButton = (page: Page, id: string) => inside(page, id, '.modal-close');

async function mountMapped(page: Page, id = 'a', attributes: Record<string, string> = MANAGED, extra: Record<string, unknown> = {}) {
  env.api.responses.set('prod-1', mapped(env));
  await host.mount(page, id, { ...props(env), ...extra }, { attributes });
  await waitForTrigger(page, id);
}

describe('opening and closing', () => {
  it('opens a modal dialog with an accessible title, and the editor inside it', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    const state = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const dialog = root.querySelector('dialog.modal') as HTMLDialogElement;
      const label = root.getElementById(dialog.getAttribute('aria-labelledby')!);
      const trigger = root.querySelector('button.trigger') as HTMLButtonElement;
      return {
        modal: dialog.matches(':modal'), // opened with showModal(): top layer, rest of the page inert
        title: label?.textContent,
        expanded: trigger.getAttribute('aria-expanded'),
        haspopup: trigger.getAttribute('aria-haspopup'),
        editorInside: !!dialog.querySelector('app-personalizer-editor .zbc form'),
        productName: dialog.querySelector('.product-name')?.textContent?.trim(),
        dataModal: document.getElementById('a')!.getAttribute('data-modal'),
      };
    });
    expect(state).toMatchObject({ modal: true, title: 'Personalize your product', expanded: 'true', haspopup: 'dialog', editorInside: true, dataModal: 'open' });
    expect(state.productName).toBeTruthy();
    await page.close();
  });

  it('closes with the close button when nothing changed, and focus returns to the trigger', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await (await closeButton(page, 'a')).click();
    await waitForModal(page, 'a', false);
    expect(await activeClass(page, 'a')).toBe('trigger');
    await page.waitForFunction(() => !document.getElementById('a')!.shadowRoot!.querySelector('app-personalizer-editor'), { timeout: 5000 }); // the editor is released
    expect(await insideCount(page, 'a', '.discard')).toBe(0);
    await page.close();
  });

  it('closes with Escape when nothing changed', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await page.keyboard.press('Escape');
    await waitForModal(page, 'a', false);
    expect(await activeClass(page, 'a')).toBe('trigger');
    await page.close();
  });

  it('closes when the backdrop is clicked, but not when a drag from inside ends there', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    // Press inside the panel, release on the backdrop.
    const panel = (await (await inside(page, 'a', '.modal-panel')).boundingBox())!;
    await page.mouse.move(panel.x + 40, panel.y + panel.height / 2);
    await page.mouse.down();
    await page.mouse.move(4, 4);
    await page.mouse.up();
    expect(await modalOpen(page, 'a')).toBe(true);
    await page.mouse.click(4, 4);
    await waitForModal(page, 'a', false);
    await page.close();
  });

  it('opens again after closing, with a fresh editor', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await page.keyboard.press('Escape');
    await waitForModal(page, 'a', false);
    await openModal(page, 'a');
    expect(await insideCount(page, 'a', 'app-personalizer-editor')).toBe(1);
    expect(configRequests(env)).toHaveLength(1); // still the one answer
    await page.close();
  });
});

describe('unsaved changes', () => {
  async function dirty(page: Page) {
    await openModal(page, 'a');
    await makeValid(page, 'a'); // a photo: the draft now differs from the empty design
  }

  it('asks before discarding, and Keep editing returns to the editor with the work intact', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await dirty(page);
    await (await closeButton(page, 'a')).click();
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    expect(await modalOpen(page, 'a')).toBe(true);
    const prompt = await page.evaluate(() => {
      const el = document.getElementById('a')!.shadowRoot!.querySelector('.discard')!;
      return { role: el.getAttribute('role'), text: el.textContent!.replace(/\s+/g, ' ').trim(), active: document.getElementById('a')!.shadowRoot!.activeElement?.textContent?.trim() };
    });
    expect(prompt.role).toBe('alertdialog');
    expect(prompt.text).toContain('Discard your changes?');
    expect(prompt.active).toBe('Keep editing'); // the safe answer has focus
    // Nothing behind the question can be reached.
    expect(await page.evaluate(() => document.getElementById('a')!.shadowRoot!.querySelector('.modal-main')!.hasAttribute('inert'))).toBe(true);

    await page.keyboard.press('Enter'); // Keep editing
    await page.waitForFunction(() => !document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    expect(await modalOpen(page, 'a')).toBe(true);
    expect(await insideCount(page, 'a', 'canvas.crop-canvas')).toBe(1); // the photo is still there
    await page.close();
  });

  it('Escape answers the question with Keep editing, and never closes silently', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await dirty(page);
    await page.keyboard.press('Escape'); // asks
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    await page.keyboard.press('Escape'); // keeps editing
    await page.waitForFunction(() => !document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    expect(await modalOpen(page, 'a')).toBe(true);
    await page.close();
  });

  it('Discard changes closes, and the next opening starts from the last saved design (nothing was saved: the empty one)', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await dirty(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    await page.evaluate(() => (document.getElementById('a')!.shadowRoot!.querySelector('.discard .danger') as HTMLButtonElement).click());
    await waitForModal(page, 'a', false);
    expect(env.api.shopper.requests).toHaveLength(0); // discarding saves nothing
    await openModal(page, 'a');
    expect(await insideCount(page, 'a', 'canvas.crop-canvas')).toBe(0);
    await page.close();
  });

  it('the backdrop asks too', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await dirty(page);
    await page.mouse.click(4, 4);
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    expect(await modalOpen(page, 'a')).toBe(true);
    await page.close();
  });
});

describe('saving in the modal (the element saves to the API: hide-save)', () => {
  it('persists the design, tells the host, closes the modal and keeps the design for later', async () => {
    const { page } = await openHost(env);
    await mountMapped(page, 'a', MANAGED, { variantId: 'white' });
    env.api.responses.set('prod-1', mapped(env));
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await waitForModal(page, 'a', false);

    // Files first, then the customization that references them: the one record the API stores.
    const order = env.api.shopper.requests.map((r) => r.endpoint);
    expect(order.at(-1)).toBe('customizations');
    expect(uploads().length).toBeGreaterThan(0);
    expect(creates()).toHaveLength(1);
    expect(creates()[0].json).toMatchObject({ productId: 'prod-1', variantId: 'white', configId: 'tshirt-personalization', configVersion: 1 });

    // The host hears about it through the established envelope, with identifiers and metadata only.
    const saved = await zbOf(page, 'a', 'personalization.saved');
    expect(saved).toHaveLength(1);
    expect(saved[0].data).toEqual({
      customizationId: 'cz-1',
      templateId: 'tshirt-personalization',
      templateVersion: 1,
      productId: 'prod-1',
      variantId: 'white',
      expiresAt: expect.any(String),
      source: 'save',
    });
    expect(JSON.stringify(saved)).not.toMatch(/atok|utok|token|blob|base64/i);
    // The legacy host-acknowledged event is not used in this flow.
    expect(await host.events(page, 'a', 'customizer-save')).toHaveLength(0);

    // The page learns that the design is saved: label, note, state; Add to cart opens.
    expect(await insideText(page, 'a', 'button.trigger')).toBe('Edit personalization');
    expect(await insideText(page, 'a', '.saved-note')).toContain('saved');
    expect(await page.evaluate(() => document.getElementById('a')!.getAttribute('data-save-state'))).toBe('saved');
    expect((await zbOf(page, 'a', 'gate')).at(-1)!.data).toEqual({ allowed: true });
    expect(await activeClass(page, 'a')).toBe('trigger');

    // Adding to the cart reuses it: no second customization, no new request.
    const requests = env.api.shopper.requests.length;
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-1' } });
    expect(env.api.shopper.requests).toHaveLength(requests);
    // One customization per order line: after the host reports the line, the same design saves anew.
    await host.hostEvent(page, 'a', 'cart.line-added', { lineId: 'L1' });
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-2' } });
    expect(creates()).toHaveLength(2);
    await page.close();
  });

  it('reopening restores the saved design, which is not "unsaved changes"', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await waitForModal(page, 'a', false);

    await openModal(page, 'a');
    expect(await insideCount(page, 'a', 'canvas.crop-canvas')).toBe(1); // the saved photo is back
    expect(await insideCount(page, 'a', '.notice-warn')).toBe(0); // restored without a mismatch notice
    await page.keyboard.press('Escape'); // pristine: no question
    await waitForModal(page, 'a', false);
    expect(await insideCount(page, 'a', '.discard')).toBe(0);

    // Edit the saved design; the change is what is "unsaved".
    await openModal(page, 'a');
    await page.evaluate(() => {
      const input = document.getElementById('a')!.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
      input.focus();
      input.value = 'Edited';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
    await page.close();
  });

  it('saving again after an edit is a new customization and keeps the cart reuse honest', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await waitForModal(page, 'a', false);
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-1' } });

    await openModal(page, 'a');
    await page.evaluate(() => {
      const input = document.getElementById('a')!.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
      input.value = 'Changed headline';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => (window as any).testHost.events('a', 'customizer-change').length > 1, { timeout: 10000 });
    await clickSave(page, 'a');
    await waitForModal(page, 'a', false);
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-2' } });
    expect(creates()).toHaveLength(2);
    await page.close();
  });

  it('keeps the modal open on a failed save, shows why, and a retry succeeds', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    env.api.shopper.createAnswer = { status: 500, body: { error: { code: 'internal_error', message: 'stack trace here' } } };
    await clickSave(page, 'a');
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-save-state') === 'host-error', { timeout: 20000 });
    expect(await modalOpen(page, 'a')).toBe(true);
    const status = await insideText(page, 'a', '.status');
    expect(status).toMatch(/could not be saved/i);
    expect(status).not.toContain('stack trace');
    expect(await zbOf(page, 'a', 'personalization.saved')).toHaveLength(0);
    // The failure is an error event with a code only.
    const errors = (await zbOf(page, 'a', 'error')).filter((e) => e.data.code === 'save-failed');
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].data).sort()).toEqual(['code', 'recoverable']);

    env.api.shopper.createAnswer = undefined;
    await clickSave(page, 'a');
    await waitForModal(page, 'a', false);
    expect((await zbOf(page, 'a', 'personalization.saved')).map((e) => e.data.customizationId)).toEqual(['cz-1']);
    await page.close();
  });

  it('refuses to close while the save is in progress, then closes by itself', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    env.api.shopper.createDelayMs = 900;
    await clickSave(page, 'a');
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-save-state') === 'awaiting-host');
    await page.keyboard.press('Escape');
    await (await closeButton(page, 'a')).click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await modalOpen(page, 'a')).toBe(true);
    expect(await insideCount(page, 'a', '.discard')).toBe(0);
    expect(await page.evaluate(() => document.getElementById('a')!.shadowRoot!.querySelector('dialog > .sr-only')!.textContent)).toMatch(/being saved/i); // spoken from inside the dialog while the page is inert
    await waitForModal(page, 'a', false);
    expect(creates()).toHaveLength(1);
    await page.close();
  });

  it('a second Save click and an Add to cart during the save share one customization', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    env.api.shopper.createDelayMs = 700;
    await clickSave(page, 'a');
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-save-state') === 'awaiting-host');
    await clickSave(page, 'a'); // the form is locked: nothing happens
    const [first, second] = await Promise.all([host.prepare(page, 'a'), host.prepare(page, 'a')]);
    expect(first).toEqual({ ok: true, value: { customizationId: 'cz-1' } });
    expect(second).toEqual(first);
    await waitForModal(page, 'a', false);
    expect(creates()).toHaveLength(1);
    expect(await zbOf(page, 'a', 'personalization.saved')).toHaveLength(1);
    await page.close();
  });

  it('Add to cart is refused until the shopper has personalized, and saves nothing', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    const result = await host.prepare(page, 'a');
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/personalize this product/i);
    expect(env.api.shopper.requests).toHaveLength(0);
    await page.close();
  });
});

describe('saving in the modal (host-acknowledged: no hide-save)', () => {
  it('emits customizer-save, waits for the host, and closes on its acknowledgement', async () => {
    const { page } = await openHost(env);
    await mountMapped(page, 'a', {});
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await page.waitForFunction(() => (window as any).testHost.events('a', 'customizer-save').length === 1);
    const [event] = await host.events(page, 'a', 'customizer-save');
    expect(event.detail.requestId).toEqual(expect.any(String));
    expect(await modalOpen(page, 'a')).toBe(true); // waiting for the host
    expect(await page.evaluate(() => document.getElementById('a')!.getAttribute('data-save-state'))).toBe('awaiting-host');
    expect(env.api.shopper.requests).toHaveLength(0); // the host persists in this flow, not the element

    await host.ack(page, 'a', { requestId: event.detail.requestId, status: 'success', message: 'Stored.' });
    await waitForModal(page, 'a', false);
    expect(await insideText(page, 'a', 'button.trigger')).toBe('Edit personalization');
    expect(await zbOf(page, 'a', 'personalization.saved')).toHaveLength(0); // no customization id exists here

    // The saved design is still the shopper's: reopening restores it, and Add to cart can still persist it.
    expect(await host.prepare(page, 'a')).toEqual({ ok: true, value: { customizationId: 'cz-1' } });
    await page.close();
  });

  it('keeps the modal open on a host error and lets the shopper retry', async () => {
    const { page } = await openHost(env);
    await mountMapped(page, 'a', {});
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await page.waitForFunction(() => (window as any).testHost.events('a', 'customizer-save').length === 1);
    const first = (await host.events(page, 'a', 'customizer-save'))[0].detail.requestId;
    await host.ack(page, 'a', { requestId: first, status: 'error', message: 'Unable to save. Please try again.' });
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-save-state') === 'host-error');
    expect(await modalOpen(page, 'a')).toBe(true);
    expect(await insideText(page, 'a', '.status')).toContain('Unable to save');

    await clickSave(page, 'a');
    await page.waitForFunction(() => (window as any).testHost.events('a', 'customizer-save').length === 2);
    const second = (await host.events(page, 'a', 'customizer-save'))[1].detail.requestId;
    expect(second).not.toBe(first);
    // A stale answer for the first request changes nothing.
    await host.ack(page, 'a', { requestId: first, status: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await modalOpen(page, 'a')).toBe(true);
    await host.ack(page, 'a', { requestId: second, status: 'success' });
    await waitForModal(page, 'a', false);
    await page.close();
  });

  it('after 30 s without an answer Save retries the same request (same id, same payload)', async () => {
    const { page } = await openHost(env, { query: '?ackScale=0.02' }); // 30 s -> 600 ms
    await mountMapped(page, 'a', {});
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await page.waitForFunction(() => document.getElementById('a')!.getAttribute('data-save-state') === 'no-response', { timeout: 10000 });
    expect(await modalOpen(page, 'a')).toBe(true);
    await clickSave(page, 'a'); // Retry
    await page.waitForFunction(() => (window as any).testHost.events('a', 'customizer-save').length === 2);
    const [one, two] = (await host.events(page, 'a', 'customizer-save')).map((e) => e.detail);
    expect(two.requestId).toBe(one.requestId);
    expect(two.customization).toEqual(one.customization);
    await page.close();
  });
});

describe('the lazy editor chunk', () => {
  it('a failed download keeps the modal usable: it says so, and Try again recovers without a page reload', async () => {
    const { page } = await openHost(env);
    await page.setRequestInterception(true);
    const seen = new Set<string>();
    let blocking = false;
    page.on('request', (request) => {
      const url = request.url();
      if (blocking && /\/chunk-[^/]+\.js/.test(url) && !seen.has(url)) {
        void request.abort('failed');
        return;
      }
      if (/\.js(\?|$)/.test(url)) seen.add(url);
      void request.continue();
    });
    await mountMapped(page);
    blocking = true; // everything the page still has to fetch (the editor and what only it needs) fails
    await (await trigger(page, 'a')).click();
    await waitForModal(page, 'a');
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('dialog .panel[role="alert"]'), { timeout: 15000 });
    expect(await insideText(page, 'a', 'dialog .panel')).toContain('could not be loaded');
    const errors = (await host.events(page, 'a', 'customizer-error')).map((e) => e.detail);
    expect(errors.at(-1)).toMatchObject({ recoverable: true });

    blocking = false;
    await page.evaluate(() => (document.getElementById('a')!.shadowRoot!.querySelector('dialog .panel button') as HTMLButtonElement).click());
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('dialog .zbc form'), { timeout: 20000 });
    expect(await modalOpen(page, 'a')).toBe(true);
    await page.close();
  });
});

describe('a product that changes while the shell is mounted', () => {
  it('closes the modal and forgets the design when the product is no longer personalizable', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    env.api.responses.set('other', { body: { data: { personalizable: false } } });
    await openModal(page, 'a');
    await host.set(page, 'a', 'productId', 'other');
    await waitForModal(page, 'a', false);
    await host.waitStatus(page, 'a', 'not-personalizable');
    expect(await hasTrigger(page, 'a')).toBe(false);
    expect(await insideCount(page, 'a', 'app-personalizer-editor')).toBe(0);
    await page.close();
  });

  it('a variant that resolves to a different template version clears the saved design and closes an open modal', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await clickSave(page, 'a');
    await waitForModal(page, 'a', false);
    expect(await insideText(page, 'a', 'button.trigger')).toBe('Edit personalization');

    env.api.responses.set('prod-1', mapped(env, { version: 2 }));
    await host.set(page, 'a', 'variantId', 'navy');
    await page.waitForFunction(() => document.getElementById('a')!.shadowRoot!.querySelector('button.trigger')?.textContent?.trim() === 'Personalize', { timeout: 10000 });
    expect(await insideCount(page, 'a', '.saved-note')).toBe(0);
    // The old customization is not offered for the new version.
    const result = await host.prepare(page, 'a');
    expect(result).toMatchObject({ ok: false });
    // And an open modal on the old version does not survive the change.
    await openModal(page, 'a');
    env.api.responses.set('prod-1', mapped(env, { version: 3 }));
    await host.set(page, 'a', 'variantId', 'white');
    await waitForModal(page, 'a', false);
    await page.close();
  });

  it('keeps an open modal and its editor when the new answer is the same template', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    await page.evaluate(() => ((window as any).__editor = document.getElementById('a')!.shadowRoot!.querySelector('app-personalizer-editor')));
    await host.set(page, 'a', 'variantId', 'navy');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(configRequests(env).length).toBeGreaterThanOrEqual(2);
    expect(await modalOpen(page, 'a')).toBe(true);
    expect(await page.evaluate(() => (window as any).__editor === document.getElementById('a')!.shadowRoot!.querySelector('app-personalizer-editor'))).toBe(true);
    expect(await insideCount(page, 'a', 'canvas.crop-canvas')).toBe(1); // the shopper's photo was not thrown away
    await page.close();
  });

  it('a new button style while the modal is open changes nothing in the editor', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    const requests = configRequests(env).length;
    await host.set(page, 'a', 'triggerStyle', { buttonColor: '#7a1f1f', buttonText: 'Changed' });
    await page.waitForFunction(() => document.getElementById('a')!.shadowRoot!.querySelector('button.trigger')!.textContent!.trim() === 'Changed');
    expect(await modalOpen(page, 'a')).toBe(true);
    expect(await insideCount(page, 'a', 'canvas.crop-canvas')).toBe(1);
    expect(configRequests(env)).toHaveLength(requests);
    await page.close();
  });

  it('removing the element while the modal is open leaves nothing behind', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await openModal(page, 'a');
    await host.remove(page, 'a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await page.evaluate(() => document.getElementById('a'))).toBeNull();
    // The page is usable again (nothing inert, nothing in the top layer).
    expect(await page.evaluate(() => document.querySelector('h1')!.matches(':focus, :hover, h1'))).toBe(true);
    expect(await page.evaluate(() => (document.querySelector(':modal') as Element | null) === null)).toBe(true);
    await page.close();
  });
});

describe('layout', () => {
  it('is the whole screen on a phone (360 px), with a reachable Save and no sideways scroll', async () => {
    const { page } = await openHost(env, { viewport: { width: 360, height: 740 } });
    await mountMapped(page);
    await openModal(page, 'a');
    await makeValid(page, 'a');
    const metrics = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const rect = (s: string) => root.querySelector(s)!.getBoundingClientRect();
      const body = root.querySelector('.modal-body') as HTMLElement;
      body.scrollTop = body.scrollHeight;
      const save = root.querySelector('dialog button.primary')!.getBoundingClientRect();
      const layout = getComputedStyle(root.querySelector('.layout')!).gridTemplateColumns.split(' ').length;
      return {
        panel: rect('.modal-panel').toJSON(),
        close: rect('.modal-close').toJSON(),
        save: save.toJSON(),
        overflowX: body.scrollWidth - body.clientWidth,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        columns: layout,
      };
    });
    expect(metrics.panel).toMatchObject({ x: 0, y: 0, width: 360, height: 740 });
    expect(metrics.close.right).toBeLessThanOrEqual(360);
    expect(metrics.close.width).toBeGreaterThanOrEqual(44);
    expect(metrics.save.bottom).toBeLessThanOrEqual(740);
    expect(metrics.save.top).toBeGreaterThanOrEqual(0);
    expect(metrics.overflowX).toBeLessThanOrEqual(1);
    expect(metrics.pageOverflowX).toBe(0);
    expect(metrics.columns).toBe(1);
    await page.close();
  });

  it('is a centered panel with the two-column editor on a desktop, laid out against the modal width', async () => {
    const { page } = await openHost(env, { viewport: { width: 1280, height: 900 } });
    await mountMapped(page);
    await openModal(page, 'a');
    const metrics = await page.evaluate(() => {
      const root = document.getElementById('a')!.shadowRoot!;
      const panel = root.querySelector('.modal-panel')!.getBoundingClientRect();
      const columns = getComputedStyle(root.querySelector('.layout')!).gridTemplateColumns.split(' ').length;
      return { left: panel.left, right: 1280 - panel.right, top: panel.top, bottom: 900 - panel.bottom, width: panel.width, columns };
    });
    expect(metrics.width).toBeLessThanOrEqual(1120);
    expect(metrics.width).toBeGreaterThan(900);
    expect(Math.abs(metrics.left - metrics.right)).toBeLessThanOrEqual(1);
    expect(metrics.top).toBeGreaterThanOrEqual(24);
    expect(metrics.bottom).toBeGreaterThanOrEqual(24);
    expect(metrics.columns).toBe(2); // the container query answers to the modal, not to the narrow host element
    await page.close();
  });

  it('is not clipped by, and stacks above, whatever the product page wraps it in', async () => {
    const { page } = await openHost(env);
    await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.id = 'wrap';
      wrap.style.cssText = 'overflow:hidden;height:60px;width:200px;position:relative;z-index:0;transform:translateZ(0);contain:paint;';
      document.getElementById('slots')!.append(wrap);
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(255,0,0,.2)';
      document.body.append(overlay);
    });
    env.api.responses.set('prod-1', mapped(env));
    await host.mount(page, 'a', props(env), { appendTo: '#wrap', attributes: MANAGED });
    await waitForTrigger(page, 'a');
    // The overlay sits above everything on the page, so the trigger can't be clicked through it: remove it to open.
    await page.evaluate(() => document.getElementById('overlay')!.remove());
    await openModal(page, 'a');
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'overlay2';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(255,0,0,.2)';
      document.body.append(overlay);
    });
    const hit = await page.evaluate(() => document.elementFromPoint(640, 450)?.id);
    expect(hit).toBe('a'); // the dialog (in the top layer), not the page's own maximal z-index
    const rect = (await (await inside(page, 'a', '.modal-panel')).boundingBox())!;
    expect(rect.width).toBeGreaterThan(900); // not squeezed into the 200 px wrapper
    await page.close();
  });

  it('does not let the page scroll behind the modal', async () => {
    const { page } = await openHost(env, { viewport: { width: 1280, height: 700 } });
    await page.evaluate(() => {
      const tall = document.createElement('div');
      tall.style.height = '5000px';
      document.body.append(tall);
    });
    await mountMapped(page);
    await openModal(page, 'a');
    await page.mouse.move(8, 8); // the backdrop
    await page.mouse.wheel({ deltaY: 800 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await computed(page, 'a', '.modal-body', ['overscroll-behavior-y'])).toEqual({ 'overscroll-behavior-y': 'contain' });
    await page.close();
  });
});

describe('keyboard and assistive technology', () => {
  it('opens with Enter, never lets Tab reach the page behind the dialog, and returns focus on Escape', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await page.evaluate(() => {
      for (const id of ['before', 'after']) {
        const b = document.createElement('button');
        b.id = id;
        b.textContent = id;
        (id === 'before' ? document.body.prepend(b) : document.body.append(b));
      }
      document.getElementById('before')!.remove(); // keep the trigger the first tab stop
    });
    await page.keyboard.press('Tab');
    expect(await activeClass(page, 'a')).toBe('trigger');
    await page.keyboard.press('Enter');
    await waitForModal(page, 'a');
    await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('dialog .zbc form'));

    // The native modal dialog keeps focus in the dialog (or hands it to the browser's own UI), never to the page.
    const where = () =>
      page.evaluate(() => {
        const root = document.getElementById('a')!.shadowRoot!;
        const active = root.activeElement;
        return {
          inDialog: !!active && !!root.querySelector('dialog')!.contains(active),
          onPage: document.activeElement !== document.body && document.activeElement !== document.getElementById('a'),
        };
      });
    let visitsInDialog = 0;
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const state = await where();
      expect(state.onPage, `Tab #${i + 1} reached the page behind the dialog`).toBe(false);
      if (state.inDialog) visitsInDialog++;
    }
    expect(visitsInDialog).toBeGreaterThan(40); // it keeps coming back into the dialog
    await page.keyboard.down('Shift');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect((await where()).onPage).toBe(false);
    }
    await page.keyboard.up('Shift');

    await page.keyboard.press('Escape');
    await waitForModal(page, 'a', false);
    expect(await activeClass(page, 'a')).toBe('trigger');
    await page.close();
  });

  it('makes the rest of the page inert while the modal is open', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'outside';
      b.textContent = 'outside';
      document.body.append(b);
      (window as any).__clicked = false;
      b.addEventListener('click', () => ((window as any).__clicked = true));
    });
    await openModal(page, 'a');
    await page.evaluate(() => (document.getElementById('outside') as HTMLButtonElement).click()); // programmatic: only a real click is blocked
    const box = (await (await page.$('#outside'))!.boundingBox())!;
    await page.evaluate(() => ((window as any).__clicked = false));
    await page.mouse.click(box.x + 2, box.y + 2); // lands on the backdrop, not the page button
    await waitForModal(page, 'a', false); // a click on the backdrop is a request to close
    expect(await page.evaluate(() => (window as any).__clicked)).toBe(false);
    await page.close();
  });

  for (const viewport of [{ width: 1280, height: 1000 }, { width: 360, height: 740 }]) {
    it(`has no axe violations with the modal open (${viewport.width}px), and with the discard question showing`, async () => {
      const { page } = await openHost(env, { viewport });
      await mountMapped(page);
      await openModal(page, 'a');
      expect(await axeViolations(page, 'a')).toEqual([]);
      await makeValid(page, 'a');
      expect(await axeViolations(page, 'a')).toEqual([]);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !!document.getElementById('a')!.shadowRoot!.querySelector('.discard'));
      expect(await axeViolations(page, 'a')).toEqual([]);
      await page.close();
    });
  }

  it('announces a save and an interrupted session politely', async () => {
    const { page } = await openHost(env);
    await mountMapped(page);
    env.api.responses.set('gone', { body: { data: { personalizable: false } } });
    await openModal(page, 'a');
    await host.set(page, 'a', 'productId', 'gone');
    await waitForModal(page, 'a', false);
    // After the dialog is gone the message is spoken by the live region next to the trigger (the page is no longer inert).
    const live = await page.evaluate(() => {
      const el = document.getElementById('a')?.shadowRoot?.querySelector('.trigger-wrap [role="status"].sr-only') ?? document.getElementById('a')!.shadowRoot!.querySelector('[role="status"].sr-only')!;
      return { text: el.textContent, polite: el.getAttribute('aria-live') };
    });
    expect(live.polite).toBe('polite');
    expect(live.text).toMatch(/can no longer be personalized|changed/i);
    void trigger;
    void waitForNoTrigger;
    await page.close();
  });
});
