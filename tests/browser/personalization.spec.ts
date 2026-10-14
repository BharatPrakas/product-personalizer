import type { Page } from 'puppeteer-core';
import {
  ASSET_PATHS,
  BLUE,
  type Environment,
  GREEN,
  NESTED,
  RED,
  type Rgba,
  YELLOW,
  animatedPng,
  clickButton,
  clickCard,
  corruptPng,
  host,
  hugePng,
  inside,
  insideAll,
  insideCount,
  insideText,
  near,
  openHost,
  quadrantJpeg,
  quadrantPng,
  startEnvironment,
  typeText,
  upload,
  withExifOrientation,
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

async function openTote(options: Parameters<typeof openHost>[1] = {}) {
  const hostPage = await openHost(env, options);
  await host.mount(hostPage.page, 't', { configUrl: TOTE });
  await host.waitStatus(hostPage.page, 't', 'ready');
  return hostPage;
}

/** Save, read the request id, acknowledge success so the form unlocks again. */
async function saveAndAck(page: Page, id: string): Promise<string> {
  const before = (await host.events(page, id, 'customizer-save')).length;
  await waitForSaveEnabled(page, id);
  await clickButton(page, id, 'Save customization');
  await page.waitForFunction(
    (i, n) => (window as any).testHost.events(i, 'customizer-save').length > n,
    {},
    id,
    before,
  );
  const events = await host.events<{ requestId: string }>(page, id, 'customizer-save');
  const { requestId } = events.at(-1)!.detail;
  await host.ack(page, id, { requestId, status: 'success' });
  await host.waitSaveState(page, id, 'saved');
  return requestId;
}

/** Colour of an artwork-space pixel as drawn on the on-screen preview (tote: placement .25/.33/.5/.5, canvas 1200). */
const displayPixel = (page: Page, id: string, ax: number, ay: number) =>
  page.evaluate(
    (i, x, y) => {
      const c = document
        .getElementById(i)!
        .shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
      const scale = (0.5 * c.width) / 1200;
      return [
        ...c
          .getContext('2d')!
          .getImageData(
            Math.round(c.width * 0.25 + x * scale),
            Math.round(c.height * 0.33 + y * scale),
            1,
            1,
          ).data,
      ];
    },
    id,
    ax,
    ay,
  );

describe('A02: fields update the preview live and independently', () => {
  it('changes text, font, colour and artwork without reloading and keeps the other fields', async () => {
    const { page, pageErrors } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await page.evaluate(() => {
      const root = document.getElementById('t')!.shadowRoot!;
      const select = root.querySelector('select') as HTMLSelectElement;
      select.value = 'serif';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      (root.querySelectorAll('.swatch')[1] as HTMLElement).click();
    });
    await clickCard(page, 't', 'Heart');
    await waitForChange(
      page,
      't',
      `(d) => d.draft.values.name.fontId === 'serif' && d.draft.values.motif.choiceId === 'heart' && d.draft.values.name.color === '#111827'`,
    );

    const draft = (await latestChange(page, 't')).draft;
    expect(draft.values.name).toEqual({ text: 'Alex', fontId: 'serif', color: '#111827' });
    expect(draft.values.motif).toEqual({ choiceId: 'heart' });
    expect(draft.values.photo).toEqual({ assetId: null, crop: null });

    // the heart is on the preview (motif layer centre), and disappears with "None"
    const heart = await displayPixel(page, 't', 1100, 100);
    expect(near(heart, [229, 72, 77], 40)).toBe(true);
    await clickCard(page, 't', 'None');
    await waitForChange(page, 't', `(d) => d.draft.values.motif.choiceId === null`);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(near(await displayPixel(page, 't', 1100, 100), [229, 72, 77], 40)).toBe(false);

    // other fields retained
    expect((await latestChange(page, 't')).draft.values.name).toEqual({
      text: 'Alex',
      fontId: 'serif',
      color: '#111827',
    });
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('debounces text changes by 150 ms and emits other changes immediately', async () => {
    const { page } = await openTote();
    const times = await page.evaluate(async () => {
      const root = document.getElementById('t')!.shadowRoot!;
      const input = root.querySelector('input[type="text"]') as HTMLInputElement;
      const stamps: { kind: string; at: number }[] = [];
      document
        .getElementById('t')!
        .addEventListener('customizer-change', (e: any) =>
          stamps.push({ kind: e.detail.draft.values.name.text, at: performance.now() }),
        );
      const type = (text: string) => {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const start = performance.now();
      type('A');
      await new Promise((r) => setTimeout(r, 50));
      type('Al');
      await new Promise((r) => setTimeout(r, 50));
      type('Ale');
      await new Promise((r) => setTimeout(r, 500));
      const afterText = stamps.map((s) => ({ text: s.kind, after: Math.round(s.at - start) }));

      const emittedBefore = stamps.length;
      const t0 = performance.now();
      const card = [...root.querySelectorAll('label.card')].find(
        (l) => l.querySelector('.card-name')!.textContent!.trim() === 'Star',
      ) as HTMLElement;
      card.click();
      await new Promise((r) => setTimeout(r, 20));
      return {
        afterText,
        immediate: stamps.length > emittedBefore,
        immediateWithin: stamps.at(-1) ? stamps.at(-1)!.at - t0 : null,
      };
    });
    expect(times.afterText).toHaveLength(1); // three keystrokes within 150 ms of each other -> one event
    expect(times.afterText[0].text).toBe('Ale');
    expect(times.afterText[0].after).toBeGreaterThanOrEqual(100 + 150 - 20);
    expect(times.immediate).toBe(true);
    expect(times.immediateWithin!).toBeLessThan(100);
    await page.close();
  });
});

describe('A03: text validation', () => {
  it('rejects over-limit text without truncating it, and disables Save', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'a'.repeat(25));
    await waitForChange(page, 't', `(d) => d.errors.some((e) => e.code === 'too-long')`);
    expect(await insideText(page, 't', '.field .errors')).toContain('at most 24');
    expect(await insideText(page, 't', '.count')).toBe('25 / 24 characters');
    expect(
      await page.evaluate(
        () =>
          (
            document
              .getElementById('t')!
              .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement
          ).value.length,
      ),
    ).toBe(25);
    expect((await latestChange(page, 't')).draft.values.name.text).toHaveLength(25);
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(true);
    expect(
      await page.evaluate(() =>
        document
          .getElementById('t')!
          .shadowRoot!.querySelector('input[type="text"]')!
          .getAttribute('aria-invalid'),
      ),
    ).toBe('true');
    await page.close();
  });

  it('counts grapheme clusters: 24 emoji-free "characters" with combining marks are fine, normalised to NFC', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Éléna'); // Latin-1: supported by the bundled font
    await waitForChange(page, 't', `(d) => d.draft.values.name.text === 'Éléna'`);
    expect(await insideText(page, 't', '.count')).toBe('5 / 24 characters');
    const change = await latestChange(page, 't');
    expect(change.errors.filter((e: any) => e.fieldId === 'name')).toEqual([]);
    await page.close();
  });

  it.each([
    ['CJK', '漢字'],
    ['emoji', 'Hi 😀'],
    ['Devanagari', 'नमस्ते'],
  ])('rejects glyphs the font cannot draw (%s) and names them', async (_label, text) => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', text);
    await waitForChange(page, 't', `(d) => d.errors.some((e) => e.code === 'unsupported-glyph')`);
    const message = (await latestChange(page, 't')).errors.find(
      (e: any) => e.code === 'unsupported-glyph',
    ).message as string;
    expect(message).toContain("can't print");
    expect(message).toContain([...text.replace(/[\sHi]/g, '')][0]);
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(true);
    await page.close();
  });

  const setName = (page: Page, text: string) =>
    page.evaluate((value) => {
      const input = document
        .getElementById('t')!
        .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  const nameErrors = async (page: Page) => {
    await new Promise((r) => setTimeout(r, 350)); // text changes are debounced by 150 ms
    return (await latestChange(page, 't')).errors
      .filter((e: any) => e.fieldId === 'name')
      .map((e: any) => e.code);
  };

  it.each([
    ['a left-to-right mark', 'a\u200eb'],
    ['a right-to-left mark', 'a\u200fb'],
    ['a byte-order mark', 'a\ufeffb'],
    ['a zero-width space', 'a\u200bb'],
    ['a soft hyphen', 'a\u00adb'],
  ])(
    'accepts text containing %s, which draws nothing (pasted from Word or RTL sources)',
    async (_label, text) => {
      const { page } = await openTote();
      await setName(page, text);
      expect(await nameErrors(page)).toEqual([]);
      await page.close();
    },
  );

  it('rejects direction overrides, which would reorder what is printed', async () => {
    const { page } = await openTote();
    await setName(page, 'ab\u202ecd');
    expect(await nameErrors(page)).toEqual(['unsupported-glyph']);
    await page.close();
  });

  it.each([
    ['a private-use character', 'a\ue000b'],
    ['an unassigned code point', 'a\u0378b'],
    ['a plane-16 private-use character', 'a\u{10fffd}b'],
  ])('rejects %s instead of printing a tofu box', async (_label, text) => {
    const { page } = await openTote();
    await setName(page, text);
    expect(await nameErrors(page)).toEqual(['unsupported-glyph']);
    await page.close();
  });

  it('does not let invisible-only text satisfy a required field', async () => {
    const { page } = await openTote();
    await setName(page, '\u200b\u200d\ufeff  \u00a0');
    expect(await nameErrors(page)).toEqual(['required']);
    await page.close();
  });

  it('accepts Cyrillic and Greek, which the bundled font covers', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Привет Ωμέγα');
    await waitForChange(page, 't', `(d) => d.draft.values.name.text === 'Привет Ωμέγα'`);
    expect((await latestChange(page, 't')).errors.map((e: any) => e.code)).toEqual(['required']); // only the photo is missing
    await page.close();
  });

  it('blocks text that cannot fit even at the minimum font size, and does not truncate it', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'p', { configUrl: POSTER });
    await host.waitStatus(page, 'p', 'ready');
    await typeText(page, 'p', 'input[type="text"]', 'W'.repeat(30)); // headline: 30 allowed, but 30 W's at 48px are wider than the box
    await waitForChange(page, 'p', `(d) => d.errors.some((e) => e.code === 'text-overflow')`);
    expect(await insideText(page, 'p', '.field .errors')).toContain('too wide');
    expect((await latestChange(page, 'p')).draft.values.headline.text).toBe('W'.repeat(30));
    expect((await insideAll(page, 'p', 'button.primary', 'disabled'))[0]).toBe(true);

    // shorter text shrinks to fit instead of failing
    await typeText(page, 'p', 'input[type="text"]', 'W'.repeat(12));
    await waitForChange(page, 'p', `(d) => !d.errors.some((e) => e.code === 'text-overflow')`);
    await page.close();
  });

  it('rejects restored text containing a line break', async () => {
    const { page } = await openHost(env);
    const customization = await page.evaluate(async (url) => {
      const config = await (await fetch(url)).json();
      return {
        schemaVersion: 1,
        productId: config.product.id,
        templateId: config.templateId,
        templateVersion: config.templateVersion,
        values: {
          name: { text: 'two\nlines', fontId: 'sans', color: '#296FD7' },
          photo: { assetId: null, crop: null },
          motif: { choiceId: null },
        },
      };
    }, TOTE);
    await host.mount(page, 'r', { configUrl: TOTE, initialCustomization: customization });
    await host.waitStatus(page, 'r', 'ready');
    await waitForChange(page, 'r', `(d) => d.errors.some((e) => e.code === 'newline')`);
    await page.close();
  });
});

describe('A06: required fields', () => {
  it('keeps Save disabled, names what is missing, and never emits a save event', async () => {
    const { page } = await openTote();
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(true);
    expect(await insideAll(page, 't', '.blockers li')).toEqual([
      'Your name is required.',
      'Your photo is required.',
    ]);
    expect(await insideText(page, 't', 'label.label')).toContain('(required)');

    // even a forced click does nothing
    await page.evaluate(() =>
      (
        document
          .getElementById('t')!
          .shadowRoot!.querySelector('button.primary') as HTMLButtonElement
      ).click(),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(await host.events(page, 't', 'customizer-save')).toEqual([]);

    // visiting a required field reveals its message beside it
    const input = await inside(page, 't', 'input[type="text"]');
    await input.focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() =>
      document.getElementById('t')!.shadowRoot!.querySelector('.field .errors .error'),
    );
    expect(await insideText(page, 't', '.field .errors .error')).toContain(
      'Your name is required.',
    );
    await page.close();
  });
});

describe('A04: photo, crop, orientation (pixel fidelity)', () => {
  const sourceColor = (
    crop: number[],
    imgW: number,
    imgH: number,
    canvasX: number,
    canvasY: number,
  ): Rgba | null => {
    // Tote photo layer: x 200, y 100, 800 x 800 on the 1200 px canvas.
    const sx = (crop[0] + (crop[2] * (canvasX - 200)) / 800) * imgW;
    const sy = (crop[1] + (crop[3] * (canvasY - 100)) / 800) * imgH;
    if (Math.abs(sx - imgW / 2) < 25 || Math.abs(sy - imgH / 2) < 25) return null; // too close to an edge between quadrants
    return [RED, GREEN, BLUE, YELLOW][(sy >= imgH / 2 ? 2 : 0) + (sx >= imgW / 2 ? 1 : 0)];
  };

  const grid = [250, 330, 410, 520, 640, 760, 880, 960].flatMap((x) =>
    [140, 230, 330, 440, 560, 680, 800, 880].map((y) => [x, y] as [number, number]),
  );

  async function assertArtworkMatchesCrop(page: Page, crop: number[], imgW: number, imgH: number) {
    const sampled = await host.pixels(page, 't', 'artwork', grid);
    let checked = 0;
    sampled.pixels.forEach((pixel, i) => {
      const expected = sourceColor(crop, imgW, imgH, grid[i][0], grid[i][1]);
      if (!expected) return;
      checked++;
      expect(
        near(pixel, expected, 8),
        `canvas ${grid[i]} was ${pixel}, expected ${expected} for crop ${crop}`,
      ).toBe(true);
    });
    expect(checked).toBeGreaterThan(30);
  }

  it('uses a centred default crop, then zoom and pan, and the exported artwork matches the crop exactly', async () => {
    const { page } = await openTote();
    const file = writeFixture(env, 'quadrants.png', quadrantPng(1800, 1200));
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', file);
    await waitForCrop(page, 't');
    await waitForChange(page, 't', `(d) => d.draft.values.photo.assetId !== null`);

    // default: largest centred square of a landscape photo
    let crop = (await latestChange(page, 't')).draft.values.photo.crop as number[];
    expect(crop[0]).toBeCloseTo(1 / 6, 6);
    expect(crop[1]).toBe(0);
    expect(crop[3]).toBe(1);
    await saveAndAck(page, 't');
    await assertArtworkMatchesCrop(page, crop, 1800, 1200);

    // zoom x2 via the slider
    await page.evaluate(() => {
      const range = document
        .getElementById('t')!
        .shadowRoot!.querySelector('input[type="range"]') as HTMLInputElement;
      range.value = '2';
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForChange(
      page,
      't',
      `(d) => Math.abs(d.draft.values.photo.crop[2] - (2/3) / 2) < 1e-6`,
    );
    crop = (await latestChange(page, 't')).draft.values.photo.crop as number[];
    expect((crop[2] * 1800) / (crop[3] * 1200)).toBeCloseTo(1, 6); // never stretched
    await saveAndAck(page, 't');
    await assertArtworkMatchesCrop(page, crop, 1800, 1200);

    // pan right with the directional button
    for (let i = 0; i < 6; i++) await clickButton(page, 't', 'Move photo right');
    await waitForChange(page, 't', `(d) => d.draft.values.photo.crop[0] > 0.4`);
    const panned = (await latestChange(page, 't')).draft.values.photo.crop as number[];
    expect(panned[0]).toBeGreaterThan(crop[0]);
    expect(panned[2]).toBeCloseTo(crop[2], 9);
    await saveAndAck(page, 't');
    await assertArtworkMatchesCrop(page, panned, 1800, 1200);

    // reset crop returns to the default window
    await clickButton(page, 't', 'Reset crop');
    await waitForChange(page, 't', `(d) => Math.abs(d.draft.values.photo.crop[2] - 2/3) < 1e-6`);
    await page.close();
  });

  it('supports dragging and the keyboard on the crop area', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', writeFixture(env, 'quadrants-kb.png', quadrantPng(1800, 1200)));
    await waitForCrop(page, 't');
    // zoom first so there is room to move
    await page.evaluate(() => {
      const range = document
        .getElementById('t')!
        .shadowRoot!.querySelector('input[type="range"]') as HTMLInputElement;
      range.value = '3';
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForChange(page, 't', `(d) => d.draft.values.photo.crop[2] < 0.25`);
    const start = (await latestChange(page, 't')).draft.values.photo.crop as number[];

    const canvas = await inside(page, 't', 'canvas.crop-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - box.width * 0.25, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    await waitForChange(page, 't', `(d) => d.draft.values.photo.crop[0] > ${start[0] + 0.001}`);
    const dragged = (await latestChange(page, 't')).draft.values.photo.crop as number[];
    expect(dragged[0] - start[0]).toBeCloseTo(start[2] * 0.25, 2); // dragging left by 25% of the view moves the window right by 25% of its width

    await canvas.focus();
    await page.keyboard.press('ArrowLeft');
    await waitForChange(page, 't', `(d) => d.draft.values.photo.crop[0] < ${dragged[0] - 0.001}`);
    await page.keyboard.press('-');
    await waitForChange(page, 't', `(d) => d.draft.values.photo.crop[2] > ${dragged[2] + 0.001}`);
    await page.close();
  });

  it('applies EXIF orientation, strips metadata and re-encodes to a canonical image', async () => {
    const { page } = await openTote();
    const plain = await quadrantJpeg(page, 1800, 1200);
    const rotated = withExifOrientation(plain, 6); // display rotated 90° clockwise
    expect(rotated.includes(Buffer.from('Exif'))).toBe(true);

    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', writeFixture(env, 'rotated.jpg', rotated));
    await waitForCrop(page, 't');
    await saveAndAck(page, 't');

    const [save] = await host.events<{
      assets: {
        width: number;
        height: number;
        mimeType: string;
        blobType: string;
        assetId: string;
      }[];
    }>(page, 't', 'customizer-save');
    expect(save.detail.assets).toHaveLength(1);
    expect(save.detail.assets[0]).toMatchObject({
      width: 1200,
      height: 1800,
      mimeType: 'image/jpeg',
      blobType: 'image/jpeg',
    });
    expect(save.detail.assets[0].assetId).toMatch(/^local-/);

    // 90° clockwise: original top-left (red) is now top-right, original bottom-left (blue) is top-left
    const { pixels } = await host.pixels(page, 't', 'asset', [
      [1190, 10],
      [10, 10],
      [1190, 1790],
      [10, 1790],
    ]);
    expect(near(pixels[0], RED, 14)).toBe(true);
    expect(near(pixels[1], BLUE, 14)).toBe(true);
    expect(near(pixels[2], GREEN, 14)).toBe(true);
    expect(near(pixels[3], YELLOW, 14)).toBe(true);

    // the canonical bytes carry no EXIF segment
    const hasExif = await page.evaluate(async () => {
      const saved = (window as any).testHost.saves.t[0].assets[0].blob as Blob;
      const bytes = new Uint8Array(await saved.arrayBuffer());
      const text = new TextDecoder('latin1').decode(
        bytes.subarray(0, Math.min(bytes.length, 4096)),
      );
      return text.includes('Exif');
    });
    expect(hasExif).toBe(false);
    await page.close();
  });

  it('can remove a photo, which makes it required again, and replace it', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', ASSET_PATHS.samplePhoto);
    await waitForCrop(page, 't');
    await waitForChange(page, 't', `(d) => d.valid`);
    await clickButton(page, 't', 'Remove photo');
    await waitForChange(page, 't', `(d) => !d.valid && d.draft.values.photo.assetId === null`);
    expect(await insideCount(page, 't', 'canvas.crop-canvas')).toBe(0);
    await upload(page, 't', ASSET_PATHS.portraitPhoto);
    await waitForCrop(page, 't');
    await waitForChange(page, 't', `(d) => d.valid`);
    await page.close();
  });
});

describe('A05: rejected photos', () => {
  const cases: [string, () => Buffer, RegExp][] = [
    ['oversized file (> 10 MB)', () => Buffer.alloc(11 * 1024 * 1024, 1), /at most 10 MB/],
    ['more than 25 megapixels', () => hugePng(), /megapixels/],
    ['corrupt image data', () => corruptPng(), /could not be read|damaged/],
    [
      'text file renamed to .png',
      () => Buffer.from('definitely not a picture'),
      /Only PNG and JPEG/,
    ],
    ['GIF', () => Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1'), /Only PNG and JPEG/],
    ['animated PNG', () => animatedPng(), /Animated/],
    ['empty file', () => Buffer.alloc(0), /empty/],
  ];

  it.each(cases)(
    'rejects %s with an actionable message and keeps the draft clean',
    async (label, bytes, message) => {
      const { page, pageErrors } = await openTote();
      const file = writeFixture(env, `${label.replace(/\W+/g, '-')}.png`, bytes());
      await upload(page, 't', file);
      // Choosing a file also marks the (still empty) required field as visited, so "Your photo is required."
      // shows at once; wait for the specific rejection message rather than for any error.
      await page.waitForFunction(
        (source) =>
          [...document.getElementById('t')!.shadowRoot!.querySelectorAll('fieldset .error')].some(
            (e) => new RegExp(source).test(e.textContent ?? ''),
          ),
        { timeout: 20000 },
        message.source,
      );
      const messages = await insideAll(page, 't', 'fieldset .error');
      expect(messages.some((m) => message.test(m))).toBe(true);
      expect((await latestChange(page, 't')).draft.values.photo).toEqual({
        assetId: null,
        crop: null,
      });
      expect(await insideCount(page, 't', 'canvas.crop-canvas')).toBe(0);

      // the shopper can recover by choosing a valid photo
      await upload(page, 't', ASSET_PATHS.samplePhoto);
      await waitForCrop(page, 't');
      expect(await insideCount(page, 't', 'fieldset .error')).toBe(0);
      expect(pageErrors).toEqual([]);
      await page.close();
    },
  );

  it('accepts a PNG exactly like a JPEG and keeps it as PNG', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', writeFixture(env, 'ok.png', quadrantPng(1200, 1200)));
    await waitForCrop(page, 't');
    await saveAndAck(page, 't');
    const [save] = await host.events<{ assets: { mimeType: string }[] }>(
      page,
      't',
      'customizer-save',
    );
    expect(save.detail.assets[0].mimeType).toBe('image/png');
    await page.close();
  });
});

describe('F06: print resolution', () => {
  it('warns below 150 DPI but still allows saving', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', writeFixture(env, 'warn.png', quadrantPng(700, 700))); // 700 px over 5.33 in = 131 DPI
    await waitForCrop(page, 't');
    await page.waitForFunction(() =>
      document.getElementById('t')!.shadowRoot!.querySelector('.warning'),
    );
    expect(await insideText(page, 't', '.warning')).toContain('131 DPI');
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(false);
    await page.close();
  });

  it('blocks below 100 DPI and recovers when the shopper zooms out / picks a bigger photo', async () => {
    const { page } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', writeFixture(env, 'tiny.png', quadrantPng(400, 400))); // 75 DPI
    await waitForCrop(page, 't');
    await waitForChange(page, 't', `(d) => d.errors.some((e) => e.code === 'low-resolution')`);
    expect(await insideText(page, 't', 'fieldset .error')).toContain('too small to print');
    expect((await insideAll(page, 't', 'button.primary', 'disabled'))[0]).toBe(true);
    await upload(page, 't', ASSET_PATHS.samplePhoto);
    await waitForChange(page, 't', `(d) => d.valid`);

    // zooming in keeps fewer source pixels, so resolution falls below the limit again
    await page.evaluate(() => {
      const range = document
        .getElementById('t')!
        .shadowRoot!.querySelector('input[type="range"]') as HTMLInputElement;
      range.value = '3'; // 1200 px / 3 = 400 px over 5.33 in = 75 DPI
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForChange(page, 't', `(d) => d.errors.some((e) => e.code === 'low-resolution')`);
    await page.close();
  });
});

describe('A07 / A08: what Save emits', () => {
  it('emits one event with serialisable JSON, PNG blobs at the right sizes, and the canonical upload', async () => {
    const { page, pageErrors } = await openTote();
    await typeText(page, 't', 'input[type="text"]', 'Alex');
    await upload(page, 't', writeFixture(env, 'save-quad.png', quadrantPng(1800, 1200)));
    await waitForCrop(page, 't');
    await clickCard(page, 't', 'Star');
    await waitForSaveEnabled(page, 't');

    const startedAt = await page.evaluate(() => performance.now());
    await clickButton(page, 't', 'Save customization');
    await host.waitSaveState(page, 't', 'awaiting-host');
    const exportMs = (await page.evaluate(() => performance.now())) - startedAt;
    console.log(`1200x1200 export (click -> customizer-save): ${exportMs.toFixed(0)} ms`);
    expect(exportMs).toBeLessThan(3000); // F12 target: export completes within 3 s

    const saves = await host.events<any>(page, 't', 'customizer-save');
    expect(saves).toHaveLength(1);
    const detail = saves[0].detail;
    expect(detail.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(detail.previewBlob).toMatchObject({ type: 'image/png' });
    expect(detail.artworkBlob).toMatchObject({ type: 'image/png' });
    expect(detail.previewBlob.size).toBeGreaterThan(1000);
    expect(detail.artworkBlob.size).toBeGreaterThan(1000);

    // JSON snapshot
    const json = JSON.stringify(detail.customization);
    expect(json).not.toContain('blob:');
    expect(json).not.toContain('data:');
    expect(json.length).toBeLessThan(2000); // no image bytes
    expect(detail.customization).toMatchObject({
      schemaVersion: 1,
      productId: 'tote-001',
      variantId: 'natural',
      templateId: 'tote-name-photo',
      templateVersion: 1,
      canvas: { width: 1200, height: 1200, background: 'transparent' },
      print: { widthMm: 203.2, heightMm: 203.2 },
      displayPrice: {
        currency: 'INR',
        exponent: 2,
        baseMinor: 49900,
        customizationFeeMinor: 10000,
        totalMinor: 59900,
        authoritative: false,
      },
    });
    expect(detail.customization.values.name).toEqual({
      text: 'Alex',
      fontId: 'sans',
      color: '#296FD7',
    });
    expect(detail.customization.values.motif).toEqual({ choiceId: 'star' });

    // the canonical upload referenced by the JSON travels as a Blob, outside the JSON
    expect(detail.assets).toHaveLength(1);
    expect(detail.assets[0]).toMatchObject({
      assetId: detail.customization.values.photo.assetId,
      mimeType: 'image/png',
      width: 1800,
      height: 1200,
    });
    expect(detail.assets[0].size).toBeGreaterThan(0);

    // artwork PNG: exactly the configured pixels, transparent, no mockup
    const artwork = await host.pixels(page, 't', 'artwork', [
      [5, 5],
      [1195, 1195],
      [600, 1100],
      [400, 300],
      [800, 700],
    ]);
    expect(artwork).toMatchObject({ width: 1200, height: 1200 });
    expect(artwork.pixels[0][3]).toBe(0); // corner: nothing printed, transparent (the mockup would be opaque here)
    expect(artwork.pixels[1][3]).toBe(0);
    expect(near(artwork.pixels[3], RED, 8)).toBe(true); // photo area carries the photo
    expect(near(artwork.pixels[4], YELLOW, 8)).toBe(true);

    // preview PNG: mockup + artwork, longest edge ≤ 1200
    const preview = await host.pixels(page, 't', 'preview', [
      [5, 5],
      [500, 546],
      [900, 700],
    ]);
    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(1200);
    expect(preview).toMatchObject({ width: 1200, height: 1200 }); // 1600 px mockup scaled down
    expect(preview.pixels[0][3]).toBe(255); // wall of the mockup
    // artwork (400, 300) -> preview (1200 * (.25 + .5 * 400/1200), 1200 * (.33 + .5 * 300/1200)) = (500, 546): the same red
    expect(near(preview.pixels[1], RED, 12)).toBe(true);

    // the same scene feeds the on-screen preview
    const onScreen = await displayPixel(page, 't', 400, 300);
    expect(near(onScreen, RED, 14)).toBe(true);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('draws a configured background colour into the artwork PNG (poster)', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 'p', { configUrl: POSTER });
    await host.waitStatus(page, 'p', 'ready');
    await waitForSaveEnabled(page, 'p');
    await clickButton(page, 'p', 'Save customization');
    await host.waitSaveState(page, 'p', 'awaiting-host');
    const artwork = await host.pixels(page, 'p', 'artwork', [
      [5, 5],
      [600, 1000],
    ]);
    expect(artwork).toMatchObject({ width: 1200, height: 1600 });
    expect(artwork.pixels[0]).toEqual([255, 253, 247, 255]);
    const preview = await host.pixels(page, 'p', 'preview', []);
    expect(preview).toMatchObject({ width: 1200, height: 900 }); // 1600x1200 mockup, longest edge 1200
    await page.close();
  });

  it('exports the text-only T-shirt, including the fixed logo layer', async () => {
    const { page } = await openHost(env);
    await host.mount(page, 's', { configUrl: TSHIRT });
    await host.waitStatus(page, 's', 'ready');
    await waitForSaveEnabled(page, 's');
    await clickButton(page, 's', 'Save customization');
    await host.waitSaveState(page, 's', 'awaiting-host');
    const [save] = await host.events<any>(page, 's', 'customizer-save');
    expect(save.detail.assets).toEqual([]);
    expect(save.detail.customization.values.team).toEqual({
      text: 'SUNRISE FC',
      fontId: 'sans',
      color: '#296FD7',
    });
    const artwork = await host.pixels(page, 's', 'artwork', [
      [600, 120],
      [5, 5],
    ]);
    expect(artwork).toMatchObject({ width: 1200, height: 1400 });
    expect(artwork.pixels[0][3]).toBeGreaterThan(200); // fixed logo mark centred at the top
    expect(artwork.pixels[1][3]).toBe(0);
    await page.close();
  });
});

describe('F10: reset', () => {
  it('asks for confirmation, keeps the draft on cancel, and restores defaults (removing local images) on confirm', async () => {
    const { page } = await openTote();
    expect(
      await page.evaluate(() =>
        document
          .getElementById('t')!
          .shadowRoot!.querySelector('button.secondary[aria-disabled]')!
          .getAttribute('aria-disabled'),
      ),
    ).toBe('true'); // nothing to reset yet

    await fillTote(page, env, 't', { name: 'Alex', artwork: 'Moon', save: false });
    await waitForChange(page, 't', `(d) => d.valid && d.draft.values.motif.choiceId === 'moon'`);
    expect(
      await page.evaluate(() =>
        document
          .getElementById('t')!
          .shadowRoot!.querySelector('button.secondary[aria-disabled]')!
          .getAttribute('aria-disabled'),
      ),
    ).toBe('false');

    await clickButton(page, 't', 'Reset');
    expect(await insideText(page, 't', '.confirm')).toContain('Reset everything');
    expect(
      await page.evaluate(() =>
        document.getElementById('t')!.shadowRoot!.activeElement?.textContent?.trim(),
      ),
    ).toBe('Yes, reset'); // focus moves into the confirmation
    await clickButton(page, 't', 'Keep editing');
    expect(await insideCount(page, 't', '.confirm')).toBe(0);
    expect((await latestChange(page, 't')).draft.values.name.text).toBe('Alex');
    expect(
      await page.evaluate(() =>
        document.getElementById('t')!.shadowRoot!.activeElement?.textContent?.trim(),
      ),
    ).toBe('Reset');

    await page.evaluate(() => {
      (window as any).closeCalls = 0;
      const original = ImageBitmap.prototype.close;
      ImageBitmap.prototype.close = function () {
        (window as any).closeCalls++;
        return original.call(this);
      };
    });
    await clickButton(page, 't', 'Reset');
    await clickButton(page, 't', 'Yes, reset');
    await waitForChange(
      page,
      't',
      `(d) => d.draft.values.name.text === '' && d.draft.values.photo.assetId === null && d.draft.values.motif.choiceId === null`,
    );
    expect(await page.evaluate(() => (window as any).closeCalls)).toBeGreaterThanOrEqual(1); // the local photo bitmap was released
    expect(await insideCount(page, 't', 'canvas.crop-canvas')).toBe(0);
    expect(
      await page.evaluate(
        () =>
          (
            document
              .getElementById('t')!
              .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement
          ).value,
      ),
    ).toBe('');
    await page.close();
  });

  it('never creates object URLs (nothing to leak) through upload, save and reset', async () => {
    const { page } = await openTote();
    await page.evaluate(() => {
      (window as any).objectUrls = 0;
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (obj: Blob | MediaSource) => {
        (window as any).objectUrls++;
        return original(obj);
      };
    });
    await fillTote(page, env, 't', { name: 'Alex' });
    await host.waitSaveState(page, 't', 'awaiting-host');
    const [save] = await host.events<{ requestId: string }>(page, 't', 'customizer-save');
    await host.ack(page, 't', { requestId: save.detail.requestId, status: 'success' });
    await host.waitSaveState(page, 't', 'saved');
    await clickButton(page, 't', 'Reset');
    await clickButton(page, 't', 'Yes, reset');
    expect(await page.evaluate(() => (window as any).objectUrls)).toBe(0);
    await page.close();
  });
});

describe('performance targets', () => {
  it('updates the preview p95 under 200 ms per keystroke on the sample configuration', async () => {
    const { page } = await openTote();
    await upload(page, 't', ASSET_PATHS.samplePhoto);
    await waitForCrop(page, 't');
    const timings = await page.evaluate(async () => {
      const input = document
        .getElementById('t')!
        .shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
      const twoFrames = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        input.value = `Name ${i} ${'x'.repeat(i % 15)}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await twoFrames();
        samples.push(performance.now() - start);
      }
      return samples;
    });
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95) - 1];
    console.log(
      `preview update (input event -> two frames painted): p50 ${sorted[20].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(200);
    await page.close();
  });
});
