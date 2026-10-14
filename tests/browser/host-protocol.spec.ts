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
  near,
  openHost,
  quadrantPng,
  startEnvironment,
  typeText,
  upload,
  writeFixture,
} from './harness';
import {
  fillTote,
  latestChange,
  waitForChange,
  waitForCrop,
  waitForSaveEnabled,
} from './personalization.helpers';

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

async function saved(page: Page, id: string) {
  return host.events<{ requestId: string; customization: any }>(page, id, 'customizer-save');
}

async function openReadyTote(query = '') {
  const hostPage = await openHost(env, { query });
  await host.mount(hostPage.page, 't', { configUrl: TOTE });
  await host.waitStatus(hostPage.page, 't', 'ready');
  return hostPage;
}

/** True when every input and select is effectively disabled (directly or through a disabled fieldset). */
const inputsDisabled = (page: Page, id: string) =>
  page.evaluate((i) => {
    const controls = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('input, select')];
    return controls.length > 0 && controls.every((c) => c.matches(':disabled'));
  }, id);

describe('A09: acknowledgements by request id', () => {
  it('freezes editing while waiting; a matching failure keeps the draft and re-enables Save with a NEW request id', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex', artwork: 'Leaf' });
    await host.waitSaveState(page, 't', 'awaiting-host');

    expect(await inputsDisabled(page, 't')).toBe(true);
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(true);
    expect(await insideText(page, 't', '.status')).toContain('Waiting for the store');

    const [first] = await saved(page, 't');
    await host.ack(page, 't', {
      requestId: first.detail.requestId,
      status: 'error',
      message: 'Storage is full.',
    });
    await host.waitSaveState(page, 't', 'host-error');
    expect(await insideText(page, 't', '.status')).toContain('Storage is full.');
    expect(await inputsDisabled(page, 't')).toBe(false);
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(false);

    // the complete draft survived
    const change = await latestChange(page, 't');
    expect(change.draft.values.name.text).toBe('Alex');
    expect(change.draft.values.motif.choiceId).toBe('leaf');
    expect(change.draft.values.photo.assetId).toMatch(/^local-/);
    expect(change.dirty).toBe(true);
    expect(change.valid).toBe(true);

    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'awaiting-host');
    const all = await saved(page, 't');
    expect(all).toHaveLength(2);
    expect(all[1].detail.requestId).not.toBe(first.detail.requestId);
    await page.close();
  });

  it('success marks the draft as saved (dirty=false); editing afterwards clears the status and is dirty again', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    const [save] = await saved(page, 't');
    await host.ack(page, 't', {
      requestId: save.detail.requestId,
      status: 'success',
      message: 'Prepared in demo',
    });
    await host.waitSaveState(page, 't', 'saved');
    expect(await insideText(page, 't', '.status')).toBe('Prepared in demo');
    await waitForChange(page, 't', `(d) => d.valid && d.dirty === false`);

    await typeText(page, 't', 'input[type="text"]', 'Alexa');
    await waitForChange(
      page,
      't',
      `(d) => d.dirty === true && d.draft.values.name.text === 'Alexa'`,
    );
    await host.waitSaveState(page, 't', 'idle');
    expect(await insideText(page, 't', '.status')).toBeFalsy();
    await page.close();
  });

  it('ignores stale, unknown and duplicate acknowledgements', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    const [first] = await saved(page, 't');

    await host.ack(page, 't', { requestId: 'not-the-request', status: 'success' });
    await new Promise((r) => setTimeout(r, 150));
    expect(await host.get(page, 't', 'saveResult')).toMatchObject({ requestId: 'not-the-request' });
    expect(await page.evaluate(() => (window as any).testHost.saveState('t'))).toBe(
      'awaiting-host',
    );

    await host.ack(page, 't', {
      requestId: first.detail.requestId,
      status: 'error',
      message: 'first failed',
    });
    await host.waitSaveState(page, 't', 'host-error');
    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'awaiting-host');
    const second = (await saved(page, 't'))[1];

    // a late success for the OLD request must not touch the new pending one
    await host.ack(page, 't', { requestId: first.detail.requestId, status: 'success' });
    await new Promise((r) => setTimeout(r, 150));
    expect(await page.evaluate(() => (window as any).testHost.saveState('t'))).toBe(
      'awaiting-host',
    );

    await host.ack(page, 't', { requestId: second.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 't', 'saved');
    // and a duplicate of the first (already settled) one afterwards is also ignored
    await host.ack(page, 't', { requestId: first.detail.requestId, status: 'error' });
    await new Promise((r) => setTimeout(r, 150));
    expect(await page.evaluate(() => (window as any).testHost.saveState('t'))).toBe('saved');
    await page.close();
  });

  it('ignores malformed acknowledgements instead of throwing', async () => {
    const { page, pageErrors } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    for (const bad of [
      {},
      { requestId: 5, status: 'success' },
      { requestId: 'x', status: 'maybe' },
      'success',
    ]) {
      await host.ack(page, 't', bad);
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(await page.evaluate(() => (window as any).testHost.saveState('t'))).toBe(
      'awaiting-host',
    );
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('emits one save event per click even if Save is clicked repeatedly', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex', save: false });
    await waitForSaveEnabled(page, 't');
    await page.evaluate(() => {
      const button = document
        .getElementById('t')!
        .shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
      button.click();
      button.click();
      button.click();
    });
    await host.waitSaveState(page, 't', 'awaiting-host');
    await new Promise((r) => setTimeout(r, 300));
    expect(await saved(page, 't')).toHaveLength(1);
    await page.close();
  });
});

describe('A10: no response, then retry with the same request', () => {
  it('shows "No response yet" after the timeout and re-sends the identical request and payload', async () => {
    const { page } = await openReadyTote('?ackScale=0.01'); // the 30 s timer becomes 300 ms in this page
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    await host.waitSaveState(page, 't', 'no-response');

    expect(await insideText(page, 't', '.status')).toContain('No response yet');
    expect(await inputsDisabled(page, 't')).toBe(true); // still frozen: the host may yet answer
    expect(await insideText(page, 't', 'button.primary')).toBe('Retry');
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(false);

    await clickButton(page, 't', 'Retry');
    await page.waitForFunction(() => (window as any).testHost.saves.t.length === 2);
    const identical = await page.evaluate(() => {
      const [a, b] = (window as any).testHost.saves.t;
      return {
        sameId: a.requestId === b.requestId,
        sameBlobs:
          a.artworkBlob === b.artworkBlob &&
          a.previewBlob === b.previewBlob &&
          a.assets[0].blob === b.assets[0].blob,
        sameJson: JSON.stringify(a.customization) === JSON.stringify(b.customization),
      };
    });
    expect(identical).toEqual({ sameId: true, sameBlobs: true, sameJson: true });

    // A host that scribbles on the event it received cannot change what a later retry carries.
    const afterMutation = await page.evaluate(() => {
      const [a] = (window as any).testHost.saves.t;
      const before = JSON.stringify(a.customization);
      a.customization.values.name.text = 'TAMPERED';
      a.assets.length = 0;
      return { before, saves: (window as any).testHost.saves.t.length };
    });
    expect(afterMutation.saves).toBe(2);
    await page.waitForFunction(() => (window as any).testHost.saveState('t') === 'no-response', {
      timeout: 5000,
    });
    await clickButton(page, 't', 'Retry');
    await page.waitForFunction(() => (window as any).testHost.saves.t.length === 3);
    const third = await page.evaluate(() => {
      const c = (window as any).testHost.saves.t[2];
      return { json: JSON.stringify(c.customization), assets: c.assets.length };
    });
    expect(third.json).toBe(afterMutation.before);
    expect(third.assets).toBe(1);

    // the host de-duplicates on request id and finally answers
    const [save] = await saved(page, 't');
    await host.ack(page, 't', { requestId: save.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 't', 'saved');
    expect(await saved(page, 't')).toHaveLength(3); // three emissions, one logical save (same id)
    await page.close();
  });

  it('still accepts a late success for the pending request after the timeout', async () => {
    const { page } = await openReadyTote('?ackScale=0.01');
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'no-response');
    const [save] = await saved(page, 't');
    await host.ack(page, 't', { requestId: save.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 't', 'saved');
    await page.close();
  });
});

describe('A11: restore a saved design', () => {
  it('restores values, crop and design from JSON plus an asset map of Blobs, and exports the same artwork', async () => {
    const { page } = await openReadyTote();
    await typeText(page, 't', 'input[type="text"]', 'Restore Me');
    await upload(page, 't', writeFixture(env, 'restore.png', quadrantPng(1800, 1200)));
    await waitForCrop(page, 't');
    await page.evaluate(() => {
      const range = document
        .getElementById('t')!
        .shadowRoot!.querySelector('input[type="range"]') as HTMLInputElement;
      range.value = '1.5';
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForChange(page, 't', `(d) => d.draft.values.photo.crop[2] < 0.5`);
    await clickButton(page, 't', 'Move photo left');
    await page.evaluate(() => {
      const card = [
        ...document.getElementById('t')!.shadowRoot!.querySelectorAll('label.card'),
      ].find((l) => l.querySelector('.card-name')!.textContent!.trim() === 'Moon') as HTMLElement;
      card.click();
    });
    await waitForSaveEnabled(page, 't');
    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'awaiting-host');
    const [original] = await saved(page, 't');
    const points: [number, number][] = [
      [260, 150],
      [500, 300],
      [800, 700],
      [950, 850],
      [1100, 100],
      [600, 1000],
    ];
    const originalPixels = await host.pixels(page, 't', 'artwork', points);

    await host.remountFromSave(page, 't', 'restored', { configUrl: TOTE });
    await host.waitStatus(page, 'restored', 'ready');
    const change = await latestChange(page, 'restored');
    expect(change.draft.values).toEqual(original.detail.customization.values);
    expect(change.valid).toBe(true);
    expect(change.dirty).toBe(false);
    expect(
      await page.evaluate(
        () =>
          (
            document
              .getElementById('restored')!
              .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement
          ).value,
      ),
    ).toBe('Restore Me');
    expect(await insideCount(page, 'restored', 'canvas.crop-canvas')).toBe(1);
    expect(await host.events(page, 'restored', 'customizer-error')).toEqual([]);

    await waitForSaveEnabled(page, 'restored');
    await clickButton(page, 'restored', 'Save customization');
    await host.waitSaveState(page, 'restored', 'awaiting-host');
    const restoredPixels = await host.pixels(page, 'restored', 'artwork', points);
    expect(restoredPixels.width).toBe(originalPixels.width);
    restoredPixels.pixels.forEach((pixel, i) =>
      expect(near(pixel, originalPixels.pixels[i], 2), `point ${points[i]}`).toBe(true),
    );
    // the same asset id comes back with the save, so the host can de-duplicate the upload
    const [again] = await saved(page, 'restored');
    expect(again.detail.customization.values.photo).toEqual(
      original.detail.customization.values.photo,
    );
    await page.close();
  });

  it('resolves asset ids from durable URLs (assetMap) as well as Blobs', async () => {
    const { page } = await openReadyTote();
    const customization = await page.evaluate(() => ({
      schemaVersion: 1,
      productId: 'tote-001',
      templateId: 'tote-name-photo',
      templateVersion: 1,
      values: {
        name: { text: 'From URL', fontId: 'sans', color: '#296FD7' },
        photo: { assetId: 'durable-1', crop: [1 / 6, 0, 2 / 3, 1] },
        motif: { choiceId: null },
      },
    }));
    await host.mount(page, 'u', {
      configUrl: TOTE,
      initialCustomization: customization,
      assetMap: { 'durable-1': `${env.corsOrigin}/assets/samples/photo-landscape.jpg` },
    });
    await host.waitStatus(page, 'u', 'ready');
    await waitForChange(page, 'u', `(d) => d.valid`);
    expect(await insideCount(page, 'u', 'canvas.crop-canvas')).toBe(1);
    await page.close();
  });

  it('does not treat a missing image as valid: it reports it and asks for a re-upload', async () => {
    const { page } = await openReadyTote();
    const customization = {
      schemaVersion: 1,
      productId: 'tote-001',
      templateId: 'tote-name-photo',
      templateVersion: 1,
      values: {
        name: { text: 'Alex', fontId: 'sans', color: '#296FD7' },
        photo: { assetId: 'gone-42', crop: [1 / 6, 0, 2 / 3, 1] },
        motif: { choiceId: 'star' },
      },
    };
    await host.mount(page, 'm', {
      configUrl: TOTE,
      initialCustomization: customization,
      assetMap: {},
    });
    await host.waitStatus(page, 'm', 'ready');
    const errors = await host.events<{ code: string; fieldId?: string; recoverable: boolean }>(
      page,
      'm',
      'customizer-error',
    );
    expect(errors.map((e) => e.detail)).toEqual([
      expect.objectContaining({ code: 'asset-missing', fieldId: 'photo', recoverable: true }),
    ]);
    const change = await latestChange(page, 'm');
    expect(change.valid).toBe(false);
    expect(change.errors.map((e: any) => e.code)).toEqual(['missing-asset']);
    expect(change.draft.values.name.text).toBe('Alex'); // everything else restored
    expect(change.draft.values.motif.choiceId).toBe('star');
    expect(await insideText(page, 'm', 'fieldset .error')).toContain('Upload it again');
    expect((await insideAll(page, 'm', 'button.primary', 'disabled'))[0]).toBe(true);

    await upload(page, 'm', ASSET_PATHS.samplePhoto);
    await waitForChange(
      page,
      'm',
      `(d) => d.valid && d.draft.values.photo.assetId.startsWith('local-')`,
    );
    await page.close();
  });

  it('rejects a draft from another template version: reports it and falls back to the defaults', async () => {
    const { page } = await openReadyTote();
    const stale = {
      schemaVersion: 1,
      productId: 'tote-001',
      templateId: 'tote-name-photo',
      templateVersion: 2,
      values: { name: { text: 'Old', fontId: 'sans', color: '#296FD7' } },
    };
    await host.mount(page, 'v', { configUrl: TOTE, initialCustomization: stale });
    await host.waitStatus(page, 'v', 'ready');
    const [error] = await host.events<{ code: string; message: string }>(
      page,
      'v',
      'customizer-error',
    );
    expect(error.detail.code).toBe('restore-mismatch');
    expect(error.detail.message).toContain('template version');
    expect((await latestChange(page, 'v')).draft.values.name.text).toBe('');
    expect(await insideText(page, 'v', '.notice-warn')).toContain('template version');
    await page.close();
  });
});

describe('A13: independent instances', () => {
  it('keeps state, save status and validation separate, and survives removing one instance', async () => {
    const { page, pageErrors } = await openHost(env);
    await host.mount(page, 'a', { configUrl: TOTE });
    await host.mount(page, 'b', { configUrl: TOTE });
    await host.mount(page, 'c', { configUrl: POSTER });
    for (const id of ['a', 'b', 'c']) await host.waitStatus(page, id, 'ready');

    await fillTote(page, env, 'a', { name: 'Only A' });
    await host.waitSaveState(page, 'a', 'awaiting-host');
    expect((await latestChange(page, 'b')).draft.values.name.text).toBe('');
    expect((await latestChange(page, 'b')).dirty).toBe(false);
    expect(await page.evaluate(() => (window as any).testHost.saveState('b'))).toBe('idle');
    expect(await page.evaluate(() => (window as any).testHost.saveState('c'))).toBe('idle');
    expect((await saved(page, 'b')).length).toBe(0);
    expect(await inputsDisabled(page, 'b')).toBe(false); // A's frozen form does not freeze B
    expect(await insideCount(page, 'b', 'canvas.crop-canvas')).toBe(0);
    expect(await insideCount(page, 'a', 'canvas.crop-canvas')).toBe(1);

    // an acknowledgement addressed to A must not affect anyone else
    const [save] = await saved(page, 'a');
    await host.ack(page, 'b', { requestId: save.detail.requestId, status: 'success' });
    await host.ack(page, 'a', { requestId: save.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 'a', 'saved');
    expect(await page.evaluate(() => (window as any).testHost.saveState('b'))).toBe('idle');

    // remove A: B keeps working, and A's bitmaps were released
    await page.evaluate(() => {
      (window as any).closeCalls = 0;
      const original = ImageBitmap.prototype.close;
      ImageBitmap.prototype.close = function () {
        (window as any).closeCalls++;
        return original.call(this);
      };
    });
    await host.remove(page, 'a');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
    // mockup + 6 artwork + local photo
    expect(await page.evaluate(() => (window as any).closeCalls)).toBeGreaterThanOrEqual(8);

    await fillTote(page, env, 'b', { name: 'Still B' });
    await host.waitSaveState(page, 'b', 'awaiting-host');
    expect((await saved(page, 'b'))[0].detail.customization.values.name.text).toBe('Still B');
    await typeText(page, 'c', 'input[type="text"]', 'Poster C');
    await waitForChange(page, 'c', `(d) => d.draft.values.headline.text === 'Poster C'`);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('a removed element emits nothing afterwards, even for late acknowledgements', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    const [save] = await saved(page, 't');
    const element = await page.evaluateHandle(() => document.getElementById('t'));
    await host.remove(page, 't');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
    const before = (await host.events(page, 't')).length;
    await page.evaluate(
      (el, id) => {
        (el as any).saveResult = { requestId: id, status: 'success' };
      },
      element,
      save.detail.requestId,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect((await host.events(page, 't')).length).toBe(before);
    await page.close();
  });
});

describe('A14: replacing the configuration', () => {
  it('a slow load for the old configuration can never overwrite the new product or emit stale events', async () => {
    const { page, pageErrors } = await openHost(env);
    await page.setRequestInterception(true);
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => (release = resolve));
    page.on('request', (request) => {
      if (request.url().includes('tote-natural.jpg')) void held.then(() => request.continue());
      else void request.continue();
    });

    await host.mount(page, 'x', { configUrl: TOTE }); // its mockup request is parked
    await page.waitForFunction(() => (window as any).testHost.status('x') === 'loading');
    await host.set(page, 'x', 'configUrl', TSHIRT);
    await host.waitStatus(page, 'x', 'ready');
    expect(await host.events(page, 'x', 'customizer-ready')).toEqual([
      expect.objectContaining({
        detail: { productId: 'tee-001', templateId: 'tshirt-team-text', templateVersion: 1 },
      }),
    ]);

    release!(); // the old product's image finally arrives
    await new Promise((r) => setTimeout(r, 800));
    expect(await host.events(page, 'x', 'customizer-ready')).toHaveLength(1);
    expect(await host.get<string>(page, 'x', 'configUrl')).toBe(TSHIRT);
    expect(await insideText(page, 'x', '.product-name')).toBe('Team T-shirt');
    const changes = await host.events<{ draft: { templateId: string } }>(
      page,
      'x',
      'customizer-change',
    );
    expect(changes.every((c) => c.detail.draft.templateId === 'tshirt-team-text')).toBe(true);
    expect(await host.events(page, 'x', 'customizer-error')).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('a new configuration resets the draft, reports the previous dirty state to the host, and makes old acknowledgements stale', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    const [save] = await saved(page, 't');
    expect((await latestChange(page, 't')).dirty).toBe(true); // the host can see unsaved work before it swaps the config

    await host.set(page, 't', 'configUrl', TSHIRT);
    await page.waitForFunction(() => (window as any).testHost.saveState('t') === 'idle');
    await host.waitStatus(page, 't', 'ready');
    await host.ack(page, 't', { requestId: save.detail.requestId, status: 'success' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await page.evaluate(() => (window as any).testHost.saveState('t'))).toBe('idle'); // stale ack ignored
    const change = await latestChange(page, 't');
    expect(change.draft.templateId).toBe('tshirt-team-text');
    expect(change.dirty).toBe(false);
    expect(await insideText(page, 't', '.product-name')).toBe('Team T-shirt');
    await page.close();
  });

  it('switching config twice quickly ends on the last one with a single ready event for it', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'q', { configUrl: TOTE });
    await host.set(page, 'q', 'configUrl', TSHIRT);
    await host.set(page, 'q', 'configUrl', POSTER);
    await host.waitStatus(page, 'q', 'ready');
    await new Promise((r) => setTimeout(r, 500));
    const ready = await host.events<{ templateId: string }>(page, 'q', 'customizer-ready');
    expect(ready.map((e) => e.detail.templateId)).toEqual(['poster-art-text']);
    await page.close();
  });
});

describe('export failures (UI state "export failed")', () => {
  it('a null Blob from the canvas surfaces a recoverable error, unlocks the form and keeps the draft', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex', save: false });
    await waitForSaveEnabled(page, 't');
    await page.evaluate(() => {
      (window as any).realToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
        callback(null);
      };
    });
    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'export-error');
    expect(await saved(page, 't')).toEqual([]);
    expect(await insideText(page, 't', '.status')).toContain('Could not prepare your design');
    const [error] = await host.events<{ code: string; recoverable: boolean }>(
      page,
      't',
      'customizer-error',
    );
    expect(error.detail).toMatchObject({ code: 'export-failed', recoverable: true });
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(false);
    expect((await latestChange(page, 't')).draft.values.name.text).toBe('Alex');

    // once the browser behaves again, the same draft saves
    await page.evaluate(() => (HTMLCanvasElement.prototype.toBlob = (window as any).realToBlob));
    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'awaiting-host');
    expect(await saved(page, 't')).toHaveLength(1);
    await page.close();
  });

  it('a tainted (cross-origin) canvas is reported as a CORS problem, not a corrupt export', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex', save: false });
    await waitForSaveEnabled(page, 't');
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.toBlob = function () {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      };
    });
    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'export-error');
    const [error] = await host.events<{ code: string; message: string }>(
      page,
      't',
      'customizer-error',
    );
    expect(error.detail.code).toBe('asset-cors');
    expect(error.detail.message).toMatch(/CORS/);
    expect(await saved(page, 't')).toEqual([]);
    await page.close();
  });
});

describe('missing assets and fonts', () => {
  it.each([
    [
      'a font file that does not exist',
      (c: any) => (c.fonts[0].src = 'fonts/missing.woff2'),
      /Font "CustomizerSans".*missing\.woff2.*HTTP 404/,
    ],
    [
      'a font file that is not a font',
      (c: any) => (c.fonts[0].src = 'mockups/tote-natural.jpg'),
      /not a valid font file/,
    ],
    [
      'a mockup that does not exist',
      (c: any) => (c.mockup.src = 'mockups/missing.jpg'),
      /missing\.jpg.*HTTP 404/,
    ],
    [
      'a clipart file that does not exist',
      (c: any) => (c.fields[2].choices[1].src = 'clipart/missing.png'),
      /missing\.png.*HTTP 404/,
    ],
    [
      'a mockup image that is not an image',
      (c: any) => (c.mockup.src = 'fonts/LICENSE-Liberation-OFL.txt'),
      /not a decodable raster image/,
    ],
  ])(
    'shows the asset-error state with a readable message for %s',
    async (_label, mutate, message) => {
      const { page } = await openHost(env);
      const config = await page.evaluate(async (url) => (await fetch(url)).json(), TOTE);
      mutate(config);
      await host.mount(page, 'a', { config, baseUrl: `${env.origin}${NESTED}/data/` });
      await host.waitStatus(page, 'a', 'asset-error');
      const errors = await host.events<{ code: string; message: string }>(
        page,
        'a',
        'customizer-error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].detail.message).toMatch(message);
      expect(await host.events(page, 'a', 'customizer-ready')).toEqual([]);
      expect(await insideCount(page, 'a', 'input')).toBe(0);
      await page.close();
    },
  );

  it('a mockup whose proportions do not match the canvas is rejected, never stretched', async () => {
    const { page } = await openHost(env);
    const config = await page.evaluate(async (url) => (await fetch(url)).json(), TOTE);
    config.mockup.src = 'mockups/poster-frame.jpg'; // 1600 x 1200 with a square placement -> 4:3 area for a 1:1 canvas
    await host.mount(page, 'a', { config, baseUrl: `${env.origin}${NESTED}/data/` });
    await host.waitStatus(page, 'a', 'invalid-config');
    const [error] = await host.events<{ message: string }>(page, 'a', 'customizer-error');
    expect(error.detail.message).toMatch(/mockup\.placement.*stretched/);
    await page.close();
  });
});

describe('limits', () => {
  it('exports the largest allowed canvas (16 megapixels) at exactly the configured pixels', async () => {
    const { page } = await openHost(env);
    const config = await page.evaluate(async (url) => {
      const c = await (await fetch(url)).json();
      const k = 4000 / 1200;
      c.canvas = { width: 4000, height: 4000, background: 'transparent' };
      for (const l of c.layers) {
        for (const key of ['x', 'y', 'width', 'height', 'fontSize', 'minFontSize'])
          if (key in l) l[key] *= k;
      }
      return c;
    }, TOTE);
    await host.mount(page, 'big', { config, baseUrl: `${env.origin}${NESTED}/data/` });
    await host.waitStatus(page, 'big', 'ready');
    await typeText(page, 'big', 'input[type="text"]', 'Big');
    await upload(page, 'big', ASSET_PATHS.samplePhoto);
    await waitForCrop(page, 'big');
    await waitForSaveEnabled(page, 'big');
    const started = Date.now();
    await clickButton(page, 'big', 'Save customization');
    await host.waitSaveState(page, 'big', 'awaiting-host', 60000);
    console.log(`4000x4000 export took ${Date.now() - started} ms`);
    const artwork = await host.pixels(page, 'big', 'artwork', [[10, 10]]);
    expect(artwork).toMatchObject({ width: 4000, height: 4000 });
    const preview = await host.pixels(page, 'big', 'preview', []);
    expect(Math.max(preview.width, preview.height)).toBe(1200);
    await page.close();
  });
});

describe('edge cases found in review', () => {
  it('drops the request, not sends it, when the host disables the element while the export runs', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex', save: false });
    await waitForSaveEnabled(page, 't');
    await page.evaluate(() => {
      (
        document
          .getElementById('t')!
          .shadowRoot!.querySelector('button.primary') as HTMLButtonElement
      ).click();
      (document.getElementById('t') as any).disabled = true; // same tick, before the export finishes
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(await saved(page, 't')).toEqual([]);
    expect(await page.evaluate(() => (window as any).testHost.saveState('t'))).toBe('idle');
    await host.set(page, 't', 'disabled', false);
    await waitForSaveEnabled(page, 't');
    await page.close();
  });

  it('locks edits in the very tick Save is clicked: a pan fired right behind the click never reaches the draft', async () => {
    const { page } = await openReadyTote();
    await fillTote(page, env, 't', { name: 'Alex', save: false });
    await waitForSaveEnabled(page, 't');
    const before = (await latestChange(page, 't')).draft.values.photo.crop;
    await page.evaluate(() => {
      const root = document.getElementById('t')!.shadowRoot!;
      (root.querySelector('button.primary') as HTMLButtonElement).click();
      const right = [...root.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === 'Move photo right',
      ) as HTMLButtonElement;
      right.click(); // same tick: change detection has not disabled the buttons yet
      right.click();
    });
    await host.waitSaveState(page, 't', 'awaiting-host');
    await new Promise((r) => setTimeout(r, 300)); // let any (wrongly) accepted edit emit its change event
    const [save] = await saved(page, 't');
    const live = await latestChange(page, 't');
    // The live draft still equals what was saved: no edit landed between the click and the lock.
    expect(live.draft.values.photo.crop).toEqual(before);
    expect(save.detail.customization.values.photo.crop).toEqual(before);
    await page.close();
  });

  it('restores a canonical image larger than the 10 MiB upload limit (re-encoded optimised PNGs can be)', async () => {
    const { page } = await openReadyTote();
    const big = await page.evaluate(async (url) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2400;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.createImageData(2400, 2400);
      crypto.getRandomValues(data.data.subarray(0, 65536)); // seed
      for (let i = 65536; i < data.data.length; i += 65536)
        crypto.getRandomValues(data.data.subarray(i, Math.min(i + 65536, data.data.length)));
      for (let i = 3; i < data.data.length; i += 4) data.data[i] = 255;
      ctx.putImageData(data, 0, 0);
      const blob: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png'),
      );
      const config = await (await fetch(url)).json();
      (window as any).testHost.mount('big', {
        configUrl: url,
        initialCustomization: {
          schemaVersion: 1,
          productId: config.product.id,
          templateId: config.templateId,
          templateVersion: config.templateVersion,
          values: {
            name: { text: 'Big', fontId: 'sans', color: '#296FD7' },
            photo: { assetId: 'durable-big', crop: [0, 0, 1, 1] },
            motif: { choiceId: null },
          },
        },
        assetMap: new Map([['durable-big', blob]]),
      });
      return blob.size;
    }, TOTE);
    expect(big).toBeGreaterThan(10 * 1024 * 1024);
    await host.waitStatus(page, 'big', 'ready');
    expect(await host.events(page, 'big', 'customizer-error')).toEqual([]);
    await waitForChange(page, 'big', `(d) => d.valid`);
    expect(await insideCount(page, 'big', 'canvas.crop-canvas')).toBe(1);
    await page.close();
  });
});
