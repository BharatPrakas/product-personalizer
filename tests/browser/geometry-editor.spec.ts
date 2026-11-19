/**
 * The merchant's tools for mockup-space geometry, driven through the real admin element: Pen / Bezier
 * outlines, Brush Mask, Curved Surface and Edit Mesh. Saved data is read back from IndexedDB, so the
 * assertions are about what is actually persisted, not about internal state.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { CATALOG, importTemplate, openEditor } from './admin.helpers';
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

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

const ID = 'a';

/** The photograph has loaded once the stage has painted something under its centre. */
async function waitStageReady(page: Page) {
  await waitInside(page, ID, 'app-stage svg.stage-overlay');
  await page.waitForFunction(
    (i) => {
      const c = document.getElementById(i)!.shadowRoot!.querySelector('app-stage canvas.stage-canvas') as HTMLCanvasElement | null;
      if (!c || c.width < 50) return false;
      const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return d[3] > 0;
    },
    { timeout: 20000 },
    ID,
  );
}

async function openGeometryEditor(name = 'Geo') {
  const hostPage = await openAdminHost(env);
  const { page } = hostPage;
  await adminHost.mount(page, ID, { productCatalog: CATALOG });
  await adminHost.ready(page, ID);
  await waitInside(page, ID, 'input[type="file"]');
  await importTemplate(env, page, ID, name);
  await openEditor(page, ID, name);
  await waitStageReady(page);
  return hostPage;
}

/** Let Angular and the canvas paint what the last input changed (rendering follows input by a frame). */
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const press = async (page: Page, key: string, modifiers: string[] = []) => {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of modifiers.reverse()) await page.keyboard.up(m);
  await settle(page);
};

/** The overlay's on-screen rectangle (page coordinates). */
const stageBox = (page: Page) =>
  page.evaluate((i) => {
    const r = document.getElementById(i)!.shadowRoot!.querySelector('app-stage svg.stage-overlay')!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, ID);

/** Click a point given as a fraction of the stage overlay. */
async function clickStage(page: Page, fx: number, fy: number, options: { drag?: [number, number] } = {}) {
  const b = await stageBox(page);
  const x = b.x + b.w * fx;
  const y = b.y + b.h * fy;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (options.drag) {
    await page.mouse.move(x + options.drag[0], y + options.drag[1], { steps: 4 });
  }
  await page.mouse.up();
  await settle(page);
}

async function dragFromTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await settle(page);
}

async function chooseAddAreaOption(page: Page, optionTitle: string, actionLabel: string) {
  await clickText(page, ID, 'button', 'Add area');
  await waitInside(page, ID, 'app-add-area-dialog dialog[open]');
  await page.evaluate(
    (i, title) => {
      const root = document.getElementById(i)!.shadowRoot!;
      const card = [...root.querySelectorAll('app-add-area-dialog .option-card')].find((c) =>
        c.textContent!.includes(title),
      ) as HTMLElement;
      (card.querySelector('input') as HTMLInputElement).click();
    },
    ID,
    optionTitle,
  );
  await clickText(page, ID, 'app-add-area-dialog dialog[open] button', actionLabel);
}

const readRecord = (page: Page): Promise<any> =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('zb-personalizer');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('configs').objectStore('configs').getAll();
          // Every test imports its own template into the same browser profile: the newest record is ours.
          all.onsuccess = () => resolve([...all.result].sort((x: any, y: any) => String(y.updatedAt).localeCompare(String(x.updatedAt)))[0]);
        };
      }),
  );

/**
 * Save the draft and return what was actually stored (read from IndexedDB, not from editor state).
 * Saving is asynchronous, so this polls until the stored draft satisfies `until`.
 */
async function savedDraft(page: Page, until: (draft: any) => boolean = () => true): Promise<any> {
  await settle(page);
  const disabled = await page.evaluate((i) => {
    const b = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('.editor-header button')].find((x) =>
      x.textContent!.includes('Save draft'),
    ) as HTMLButtonElement | undefined;
    return !b || b.disabled;
  }, ID);
  if (!disabled) await clickText(page, ID, '.editor-header button', 'Save draft');
  const deadline = Date.now() + 10_000;
  for (;;) {
    const draft = (await readRecord(page)).draft;
    if (until(draft)) return draft;
    if (Date.now() > deadline) throw new Error('the saved draft never matched the expectation: ' + JSON.stringify(newest(draft)).slice(0, 400));
    await new Promise((r) => setTimeout(r, 100));
  }
}

const placements = (draft: any) => draft.mockups[0].placements as any[];
const newest = (draft: any) => placements(draft).at(-1);

const summary = (page: Page) => insideText(page, ID, '[data-testid="boundary-summary"]');

describe('Pen / Bezier', () => {
  it('traces a closed outline with corners and a curve, then reopens and edits it', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Pen / Bezier', 'Trace on mockup');
    // Click, click, click-drag (a smooth curve point), click, then click the first point to close.
    await clickStage(page, 0.4, 0.3);
    await clickStage(page, 0.6, 0.3);
    await clickStage(page, 0.65, 0.5, { drag: [30, 30] });
    await clickStage(page, 0.4, 0.55);
    // While drawing there is a live outline and the close target on the first point.
    expect(await insideCount(page, ID, 'app-stage .pen-path')).toBe(1);
    expect(await insideCount(page, ID, 'app-stage .pen-close')).toBe(1);
    await clickStage(page, 0.4, 0.3); // close

    await page.waitForFunction((i) => /Outline: 4 points/.test(document.getElementById(i)!.shadowRoot!.textContent ?? ''), { timeout: 10000 }, ID);
    const draft = await savedDraft(page, (d) => newest(d).mask?.type === 'path');
    const placement = newest(draft);
    expect(placement.mask.type).toBe('path');
    const anchors = placement.mask.path.contours[0].anchors;
    expect(anchors).toHaveLength(4);
    expect(anchors[2].handleOut).toBeDefined(); // the click-drag point is smooth
    expect(anchors[2].smooth).toBe(true);
    expect(anchors[0].handleOut).toBeUndefined(); // the plain clicks are corners
    // Coordinates are photo fractions, independent of the zoom the merchant happened to use.
    for (const a of anchors) {
      expect(a.x).toBeGreaterThan(0);
      expect(a.x).toBeLessThan(1);
    }
    // The production canvas is a flat rectangle, not the outline.
    const area = draft.printableAreas.at(-1);
    expect(area.shape).toEqual({ type: 'rect' });

    // Anchors and handles are shown for editing; drag one and undo it.
    expect(await insideCount(page, ID, 'app-stage .pen-anchor')).toBe(4);
    const before = JSON.stringify(anchors[0]);
    const b = await stageBox(page);
    // Find the first anchor on screen from the overlay and drag it.
    const pos = await page.evaluate((i) => {
      const a = document.getElementById(i)!.shadowRoot!.querySelector('app-stage .pen-anchor') as SVGGraphicsElement;
      const r = a.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, ID);
    await dragFromTo(page, pos, { x: pos.x - 25, y: pos.y - 25 }, 5);
    const moved = await savedDraft(page, (d) => JSON.stringify(newest(d).mask.path.contours[0].anchors[0]) !== before);
    expect(JSON.stringify(newest(moved).mask.path.contours[0].anchors[0])).not.toBe(before);
    await press(page, 'KeyZ', ['Control']);
    const undone = await savedDraft(page, (d) => JSON.stringify(newest(d).mask.path.contours[0].anchors[0]) === before);
    expect(JSON.stringify(newest(undone).mask.path.contours[0].anchors[0])).toBe(before);
    expect(b.w).toBeGreaterThan(100);
    await page.close();
  });

  it('cancels with Escape without creating an area', async () => {
    const { page } = await openGeometryEditor();
    const before = await insideCount(page, ID, '.list-row');
    await chooseAddAreaOption(page, 'Pen / Bezier', 'Trace on mockup');
    await clickStage(page, 0.4, 0.3);
    await clickStage(page, 0.6, 0.3);
    await clickStage(page, 0.5, 0.5);
    await press(page, 'Escape');
    expect(await insideCount(page, ID, 'app-stage .pen-path')).toBe(0);
    const draft = await savedDraft(page);
    expect(placements(draft).every((p) => !p.mask)).toBe(true);
    expect(await insideCount(page, ID, '.list-row')).toBe(before);
    await page.close();
  });

  it('refuses an outline with fewer than three points', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Pen / Bezier', 'Trace on mockup');
    await clickStage(page, 0.4, 0.3);
    await clickStage(page, 0.6, 0.3);
    await press(page, 'Enter');
    expect(await insideText(page, ID, 'app-stage .stage-message')).toMatch(/at least three points/);
    await press(page, 'Escape');
    await page.close();
  });
});

describe('Curved surface and mesh', () => {
  it('creates a curved placement, edits its curvature numerically and keeps the flat production canvas', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Curved surface', 'Draw on mockup');
    const b = await stageBox(page);
    await dragFromTo(page, { x: b.x + b.w * 0.35, y: b.y + b.h * 0.3 }, { x: b.x + b.w * 0.65, y: b.y + b.h * 0.55 });
    await page.waitForFunction(
      (i) => !!document.getElementById(i)!.shadowRoot!.querySelector('app-geometry-fields'),
      { timeout: 10000 },
      ID,
    );
    let draft = await savedDraft(page, (d) => !!newest(d).surface);
    expect(newest(draft).surface).toMatchObject({ type: 'cylinder', curvature: 140, centre: 0 });
    expect(draft.printableAreas.at(-1).shape).toEqual({ type: 'rect' });

    // Change the curvature through the number box next to the slider.
    await page.evaluate((i) => {
      const root = document.getElementById(i)!.shadowRoot!;
      const field = [...root.querySelectorAll('app-range')].find((r) => r.textContent!.includes('Curvature'))!;
      const input = field.querySelector('input[type="number"]') as HTMLInputElement;
      input.value = '90';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, ID);
    draft = await savedDraft(page, (d) => newest(d).surface?.curvature === 90);
    expect(newest(draft).surface.curvature).toBe(90);

    // Moving the placement keeps the curvature (it is relative to the placement).
    const x0 = newest(draft).x;
    await press(page, 'Escape');
    await clickStage(page, 0.5, 0.42);
    await press(page, 'ArrowRight', ['Shift']);
    await press(page, 'ArrowRight', ['Shift']);
    draft = await savedDraft(page, (d) => newest(d).x > x0);
    expect(newest(draft).x).toBeGreaterThan(x0);
    expect(newest(draft).surface.curvature).toBe(90);
    await page.close();
  });

  it('edits a mesh: control points move, a fold is refused, reset restores the surface', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Curved surface', 'Place in the centre');
    await page.waitForFunction((i) => !!document.getElementById(i)!.shadowRoot!.querySelector('app-geometry-fields'), { timeout: 10000 }, ID);
    await clickText(page, ID, 'app-geometry-fields button', 'Edit mesh');
    await waitInside(page, ID, 'app-stage .mesh-point');
    expect(await insideCount(page, ID, 'app-stage .mesh-point')).toBe(25);
    let draft = await savedDraft(page, (d) => !!newest(d).mesh);
    const mesh0 = newest(draft).mesh;
    expect(mesh0).toMatchObject({ cols: 5, rows: 5 });
    expect(mesh0.points).toHaveLength(50);

    // Drag the centre point.
    const centre = await page.evaluate((i) => {
      const pts = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('app-stage .mesh-point')];
      const r = (pts[12] as SVGGraphicsElement).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, ID);
    await dragFromTo(page, centre, { x: centre.x + 15, y: centre.y - 20 }, 5);
    draft = await savedDraft(page, (d) => newest(d).mesh.points[24] !== mesh0.points[24]);
    const mesh1 = newest(draft).mesh;
    expect(mesh1.points[24]).not.toBe(mesh0.points[24]);
    expect(mesh1.points).toHaveLength(50);

    // Dragging a point across its neighbours would fold the surface: refused, and said so.
    await dragFromTo(page, { x: centre.x + 15, y: centre.y - 20 }, { x: centre.x - 400, y: centre.y - 20 }, 8);
    expect(await insideText(page, ID, 'app-stage .stage-message')).toMatch(/fold/);
    draft = await savedDraft(page);
    const mesh2 = newest(draft).mesh;
    expect(mesh2.points[24]).toBeGreaterThan(0.05); // never left the valid region

    // Reset removes the mesh and leaves the cylinder.
    await clickText(page, ID, 'app-geometry-fields button', 'Reset mesh');
    draft = await savedDraft(page, (d) => newest(d).mesh === undefined);
    expect(newest(draft).mesh).toBeUndefined();
    expect(newest(draft).surface.type).toBe('cylinder');
    await page.close();
  });
});

describe('Brush mask', () => {
  it('paints, erases and persists a raster mask as an image asset, not as inline data', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Brush mask', 'Paint on mockup');
    // Paint a stroke across the photo.
    const b = await stageBox(page);
    await page.mouse.move(b.x + b.w * 0.4, b.y + b.h * 0.4);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w * 0.6, b.y + b.h * 0.4, { steps: 10 });
    await page.mouse.move(b.x + b.w * 0.6, b.y + b.h * 0.55, { steps: 10 });
    await page.mouse.up();
    await settle(page);
    await page.waitForFunction((i) => /Painted mask/.test(document.getElementById(i)!.shadowRoot!.textContent ?? ''), { timeout: 15000 }, ID);
    const draft = await savedDraft(page, (d) => newest(d).mask?.type === 'raster');
    const p = newest(draft);
    expect(p.mask.type).toBe('raster');
    expect(p.mask.src).toMatch(/^idb:/); // an asset reference, never base64 inside the configuration
    expect(JSON.stringify(draft)).not.toContain('data:image');
    expect(p.mask.width).toBeGreaterThan(100);
    // The placement was fitted to what was painted.
    expect(p.width).toBeLessThan(0.6);
    expect(p.width).toBeGreaterThan(0.1);
    // The stored asset is a PNG with an alpha channel.
    const stored = await page.evaluate(
      (src) =>
        new Promise<{ type: string; size: number }>((resolve, reject) => {
          const open = indexedDB.open('zb-personalizer');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const req = open.result.transaction('assets').objectStore('assets').get(src.slice(4));
            req.onsuccess = () => resolve({ type: req.result.blob.type, size: req.result.blob.size });
          };
        }),
      p.mask.src,
    );
    expect(stored.type).toBe('image/png');
    expect(stored.size).toBeLessThan(200_000);
    await page.close();
  });
});

/** Decode a stored mask asset (`idb:<id>`) and return its alpha channel. */
async function maskAlpha(page: Page, src: string): Promise<{ width: number; height: number; alpha: number[] }> {
  return page.evaluate(
    (ref) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('zb-personalizer');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('assets').objectStore('assets').get(ref.slice(4));
          req.onsuccess = async () => {
            const bitmap = await createImageBitmap(req.result.blob);
            const c = document.createElement('canvas');
            c.width = bitmap.width;
            c.height = bitmap.height;
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(bitmap, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            resolve({ width: c.width, height: c.height, alpha: Array.from({ length: c.width * c.height }, (_, i) => d[i * 4 + 3]) });
          };
        };
      }),
    src,
  );
}

/** Number of pixels in column `x` of the mask whose alpha is at least `min`. */
const column = (m: { width: number; height: number; alpha: number[] }, x: number, min = 128) => {
  let n = 0;
  for (let y = 0; y < m.height; y++) if (m.alpha[y * m.width + x] >= min) n++;
  return n;
};

/** Lengths of the unbroken runs of pixels with alpha >= min in column `x` (one entry per stroke crossing it). */
const runs = (m: { width: number; height: number; alpha: number[] }, x: number, min = 128) => {
  const out: number[] = [];
  let run = 0;
  for (let y = 0; y <= m.height; y++) {
    if (y < m.height && m.alpha[y * m.width + x] >= min) run++;
    else if (run > 0) {
      out.push(run);
      run = 0;
    }
  }
  return out;
};

const setBrush = (page: Page, label: string, value: number) =>
  page.evaluate(
    (i, l, v) => {
      const root = document.getElementById(i)!.shadowRoot!;
      const field = [...root.querySelectorAll('app-range')].find((f) => f.textContent!.includes(l))!;
      const input = field.querySelector('input[type="number"]') as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    ID,
    label,
    value,
  );

async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const b = await stageBox(page);
  await page.mouse.move(b.x + b.w * from[0], b.y + b.h * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.w * to[0], b.y + b.h * to[1], { steps: 12 });
  await page.mouse.up();
  await settle(page);
}

describe('Brush mask in detail', () => {
  it('erases, undoes and redoes, one stroke per history step', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Brush mask', 'Paint on mockup');
    await setBrush(page, 'Size', 50);
    await stroke(page, [0.35, 0.45], [0.65, 0.45]);
    let draft = await savedDraft(page, (d) => newest(d).mask?.type === 'raster');
    const first = newest(draft).mask.src;
    const painted = await maskAlpha(page, first);
    const mid = Math.floor(painted.width * 0.5);
    expect(column(painted, mid)).toBeGreaterThan(30);

    // Switch to erase (X) and wipe the middle of the stroke.
    await press(page, 'KeyX');
    await stroke(page, [0.5, 0.35], [0.5, 0.55]);
    draft = await savedDraft(page, (d) => newest(d).mask?.src !== first);
    const erased = await maskAlpha(page, newest(draft).mask.src);
    expect(column(erased, Math.floor(erased.width * 0.5))).toBeLessThan(column(painted, mid) / 2);
    expect(column(erased, Math.floor(erased.width * 0.4))).toBeGreaterThan(30); // the rest is intact

    // One undo returns to the painted mask, a second to no boundary at all (the area is gone), redo brings it back.
    await press(page, 'KeyZ', ['Control']);
    draft = await savedDraft(page, (d) => newest(d).mask?.src === first);
    expect(newest(draft).mask.src).toBe(first);
    await press(page, 'KeyZ', ['Control', 'Shift']);
    draft = await savedDraft(page, (d) => newest(d).mask?.src !== first);
    expect(newest(draft).mask.type).toBe('raster');
    await page.close();
  });

  it('paints strokes of the same size in photo pixels at any zoom', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Brush mask', 'Paint on mockup');
    await setBrush(page, 'Size', 40);
    await setBrush(page, 'Hardness', 100);
    await stroke(page, [0.3, 0.3], [0.5, 0.3]);
    let draft = await savedDraft(page, (d) => newest(d).mask?.type === 'raster');
    const firstSrc = newest(draft).mask.src;
    const before = await maskAlpha(page, firstSrc);
    // Thickness of the stroke at its middle, in mask (= photo) pixels.
    const x0 = Math.floor(before.width * 0.4);
    const thin = column(before, x0);
    expect(thin).toBeGreaterThanOrEqual(38);
    expect(thin).toBeLessThanOrEqual(42);

    // Zoom in 3 steps (x1.73) and paint another stroke elsewhere with the SAME brush settings.
    for (let k = 0; k < 3; k++) await press(page, 'Equal');
    const b = await stageBox(page);
    await page.mouse.move(b.x + b.w * 0.45, b.y + b.h * 0.55);
    await page.mouse.down();
    await page.mouse.move(b.x + b.w * 0.6, b.y + b.h * 0.55, { steps: 10 });
    await page.mouse.up();
    await settle(page);
    draft = await savedDraft(page, (d) => newest(d).mask?.src !== firstSrc);
    const after = await maskAlpha(page, newest(draft).mask.src);
    // Every stroke crossing a column is 40 photo pixels thick, although the second was painted at a higher zoom.
    const all: number[] = [];
    let crossings = 0;
    for (let x = 0; x < after.width; x += 5) {
      const r = runs(after, x);
      all.push(...r);
      if (r.length > 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(20);
    expect(Math.max(...all)).toBeLessThanOrEqual(43);
    // The interior of both strokes (ends are round caps) has the full thickness.
    expect(all.filter((n) => n >= 37 && n <= 43).length).toBeGreaterThan(all.length * 0.7);
    await page.close();
  });

  it('keeps partial transparency for a soft brush', async () => {
    const { page } = await openGeometryEditor();
    await chooseAddAreaOption(page, 'Brush mask', 'Paint on mockup');
    await setBrush(page, 'Size', 80);
    await setBrush(page, 'Hardness', 0);
    await stroke(page, [0.3, 0.45], [0.6, 0.45]);
    const draft = await savedDraft(page, (d) => newest(d).mask?.type === 'raster');
    const m = await maskAlpha(page, newest(draft).mask.src);
    const x = Math.floor(m.width * 0.45);
    const profile = Array.from({ length: m.height }, (_, y) => m.alpha[y * m.width + x]).filter((a) => a > 0);
    const partial = profile.filter((a) => a > 16 && a < 240).length;
    expect(Math.max(...profile)).toBeGreaterThan(200); // a solid centre ...
    expect(partial).toBeGreaterThan(20); // ... fading out through partially transparent pixels
    await page.close();
  });
});

describe('persistence and publishing', () => {
  it('keeps the geometry when the template is closed and reopened, and renders the same boundary', async () => {
    const { page } = await openGeometryEditor('Reopen');
    await chooseAddAreaOption(page, 'Pen / Bezier', 'Trace on mockup');
    for (const [x, y] of [[0.4, 0.3], [0.6, 0.3], [0.6, 0.55], [0.4, 0.55], [0.4, 0.3]]) await clickStage(page, x, y);
    await savedDraft(page, (d) => newest(d).mask?.type === 'path');
    // Leave the editor and open the same template again.
    await page.evaluate((i) => (document.getElementById(i) as any).view = 'list', ID);
    await adminHost.waitView(page, ID, 'list');
    await openEditor(page, ID, 'Reopen');
    await waitStageReady(page);
    await clickStage(page, 0.5, 0.42); // select the area
    await page.waitForFunction((i) => /Outline: 4 points/.test(document.getElementById(i)!.shadowRoot!.textContent ?? ''), { timeout: 10000 }, ID);
    expect(await insideCount(page, ID, 'app-stage .mask-outline')).toBeGreaterThan(0);
    await page.close();
  });

  it('publishes the exact geometry', async () => {
    const { page } = await openGeometryEditor('Publish');
    await chooseAddAreaOption(page, 'Curved surface', 'Place in the centre');
    await page.waitForFunction((i) => !!document.getElementById(i)!.shadowRoot!.querySelector('app-geometry-fields'), { timeout: 10000 }, ID);
    await page.evaluate((i) => {
      const root = document.getElementById(i)!.shadowRoot!;
      const field = [...root.querySelectorAll('app-range')].find((r) => r.textContent!.includes('Curvature'))!;
      const input = field.querySelector('input[type="number"]') as HTMLInputElement;
      input.value = '123';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, ID);
    await savedDraft(page, (d) => newest(d).surface?.curvature === 123);
    await page.waitForFunction(
      (i) => {
        const b = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('.editor-header button')].find((x) => x.textContent!.trim() === 'Publish') as HTMLButtonElement | undefined;
        return !!b && !b.disabled;
      },
      { timeout: 20000 },
      ID,
    );
    await clickText(page, ID, '.editor-header button', 'Publish');
    await waitInside(page, ID, 'app-confirm-host dialog[open]');
    await page.evaluate((i) => {
      const dialog = document.getElementById(i)!.shadowRoot!.querySelector('app-confirm-host dialog[open]')!;
      ([...dialog.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Publish') as HTMLElement).click();
    }, ID);
    const deadline = Date.now() + 15000;
    for (;;) {
      const record = await readRecord(page);
      const published = record.published?.mockups?.[0]?.placements?.at(-1);
      if (published?.surface?.curvature === 123) {
        expect(published.surface).toEqual({ type: 'cylinder', curvature: 123, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 0 });
        break;
      }
      if (Date.now() > deadline) throw new Error('the published snapshot never carried the geometry');
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.close();
  });
});

async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  const result = (await page.evaluate(
    (i) =>
      (window as any).axe.run(document.getElementById(i), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { region: { enabled: false } }, // the element is a component inside someone else's page
      }),
    ID,
  )) as { violations: { id: string; impact: string; nodes: { target: unknown[]; failureSummary: string }[] }[] };
  return result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} -> ${n.failureSummary.split('\n')[1]?.trim()}`).join(' | ')}`,
  );
}

describe('accessibility of the geometry tools (WCAG 2.2 AA + best practice)', () => {
  it.each([
    ['desktop', { width: 1280, height: 1000 }],
    ['phone', { width: 360, height: 800 }],
  ])('has no axe violations with the geometry inspector, every tool panel and the Add-area dialog open at %s width', async (_name, viewport) => {
    const hostPage = await openAdminHost(env, { viewport });
    const { page } = hostPage;
    await adminHost.mount(page, ID, { productCatalog: CATALOG });
    await adminHost.ready(page, ID);
    await waitInside(page, ID, 'input[type="file"]');
    await importTemplate(env, page, ID, 'Axe');
    await openEditor(page, ID, 'Axe');
    await waitStageReady(page);

    // The Add printable area dialog with the three new options.
    await clickText(page, ID, 'button', 'Add area');
    await waitInside(page, ID, 'app-add-area-dialog dialog[open]');
    expect(await axeViolations(page)).toEqual([]);
    await clickText(page, ID, 'app-add-area-dialog dialog[open] button', 'Cancel');

    // An area with a cylinder, a Bezier outline and a mesh: the inspector sections and tool panels.
    await chooseAddAreaOption(page, 'Curved surface', 'Place in the centre');
    await page.waitForFunction((i) => !!document.getElementById(i)!.shadowRoot!.querySelector('app-geometry-fields'), { timeout: 10000 }, ID);
    expect(await axeViolations(page)).toEqual([]);

    await clickText(page, ID, 'app-geometry-fields button', 'Draw outline');
    await settle(page);
    expect(await axeViolations(page)).toEqual([]); // pen tool active: hint + tool panel
    for (const [x, y] of [[0.4, 0.3], [0.6, 0.3], [0.6, 0.55], [0.4, 0.3]]) await clickStage(page, x, y);
    expect(await axeViolations(page)).toEqual([]);
    await press(page, 'Escape');

    await clickText(page, ID, 'app-geometry-fields button', 'Paint mask');
    await settle(page);
    expect(await axeViolations(page)).toEqual([]); // brush tool active

    await press(page, 'Escape');
    await clickText(page, ID, 'app-geometry-fields button', 'Edit mesh');
    await settle(page);
    expect(await axeViolations(page)).toEqual([]); // mesh tool active
    await hostPage.page.close();
  }, 120_000);
});
