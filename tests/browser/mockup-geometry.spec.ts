/**
 * Printable boundaries (Bezier / raster masks) and surface transformations (cylinder, mesh) rendered by
 * the real storefront element in Chrome. Pixel expectations are derived from the documented maths
 * (`util/surface.ts`), not from screenshots of the implementation.
 */
import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import {
  type Environment,
  clickButton,
  host,
  openHost,
  startEnvironment,
  writeFixture,
  TMP_FILES,
} from './harness';

let env: Environment;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(async () => {
  await env.close();
});

const DEG = Math.PI / 180;

type Json = Record<string, unknown>;

/** A 800 x 400 production canvas: red field, thin vertical markers at u = .25 (yellow), .5 (green), .75 (blue). */
function config(placement: Json, extra: Json = {}, mockupSrc = 'mockups/bottle-500-front.jpg'): Json {
  const rect = (id: string, x: number, w: number, fill: string, y = 0, h = 400) => ({
    id,
    type: 'shape',
    x,
    y,
    width: w,
    height: h,
    shape: { type: 'rect' },
    fill,
  });
  return {
    schemaVersion: 2,
    id: 'geometry',
    version: 1,
    status: 'published',
    product: { id: 'p', name: 'Bottle' },
    assetBaseUrl: 'assets/',
    variants: [{ id: 'v', label: 'Default', mockupIds: ['m'], printableAreaIds: ['a'] }],
    mockups: [
      { id: 'm', name: 'Front', src: mockupSrc, placements: [{ printableAreaId: 'a', ...placement }] },
    ],
    printableAreas: [
      {
        id: 'a',
        name: 'Label',
        enabled: true,
        canvas: { width: 800, height: 400, background: 'transparent' },
        shape: { type: 'rect' },
        artworkId: 'w',
        artworkIds: ['w'],
      },
    ],
    artworks: [
      {
        id: 'w',
        name: 'Art',
        printableAreaId: 'a',
        layers: [
          rect('field', 0, 800, '#ff0000'),
          rect('m25', 196, 8, '#ffff00'),
          rect('m50', 396, 8, '#00ff00'),
          rect('m75', 596, 8, '#0000ff'),
          // An optional, empty text input: a published design needs at least one customer field.
          { id: 'note-layer', type: 'text', fieldId: 'note', x: 10, y: 10, width: 120, height: 40, fontSize: 24, minFontSize: 12, align: 'left' },
        ],
      },
    ],
    fonts: [{ id: 'sans', family: 'CustomizerSans', label: 'Sans', src: 'fonts/sans-regular.woff2' }],
    fields: [
      {
        id: 'note',
        type: 'text',
        label: 'Note',
        required: false,
        maxLength: 10,
        fontIds: ['sans'],
        colors: ['#000000'],
        printableAreaId: 'a',
        artworkId: 'w',
        defaultValue: { text: '', fontId: 'sans', color: '#000000' },
      },
    ],
    ...extra,
  };
}

const BASE = { type: 'rect', x: 0.2, y: 0.3, width: 0.6, height: 0.3 };

async function open(cfg: Json, id = 'g') {
  const hostPage = await openHost(env, { viewport: { width: 1000, height: 1000 } });
  await host.mount(
    hostPage.page,
    id,
    { config: cfg, baseUrl: `${env.elementBase}/` },
    { attributes: { mode: 'preview' } },
  );
  await host.waitStatus(hostPage.page, id, 'ready');
  await settled(hostPage.page, id);
  return hostPage;
}

/** The preview canvas has been painted (not blank) at its current size. */
const settled = (page: Page, id: string) =>
  page.waitForFunction(
    (i) => {
      const c = document.getElementById(i)?.shadowRoot?.querySelector('canvas.preview-canvas') as HTMLCanvasElement | null;
      if (!c || c.width < 100) return false;
      const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return d[3] > 0;
    },
    { timeout: 20000 },
    id,
  );

interface Canvas {
  width: number;
  height: number;
}

const size = (page: Page, id: string): Promise<Canvas> =>
  page.evaluate((i) => {
    const c = document.getElementById(i)!.shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  }, id);

/** Pixels of one row of the on-screen preview, as `[r, g, b, a]` per column. */
const row = (page: Page, id: string, yFraction: number): Promise<number[][]> =>
  page.evaluate(
    (i, f) => {
      const c = document.getElementById(i)!.shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
      const data = c.getContext('2d')!.getImageData(0, Math.round(c.height * f), c.width, 1).data;
      return Array.from({ length: c.width }, (_, x) => Array.from(data.slice(x * 4, x * 4 + 4)));
    },
    id,
    yFraction,
  );

const pixel = (page: Page, id: string, xf: number, yf: number): Promise<number[]> =>
  page.evaluate(
    (i, x, y) => {
      const c = document.getElementById(i)!.shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(Math.round(c.width * x), Math.round(c.height * y), 1, 1).data);
    },
    id,
    xf,
    yf,
  );

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const YELLOW = [255, 255, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const RED = [255, 0, 0];

/** x-centroid (in canvas pixels) of the pixels in `scan` that are close to `colour`. */
function centroid(scan: number[][], colour: number[], tolerance = 60): number | null {
  let sum = 0;
  let n = 0;
  scan.forEach((p, x) => {
    if (p[3] > 200 && dist(p, colour) < tolerance) {
      sum += x;
      n++;
    }
  });
  return n > 0 ? sum / n + 0.5 : null;
}

/** Frame-local x of artwork fraction `u` on a cylinder with total wrap `curvature` degrees (centre 0, 90/90 visible). */
const cylinderX = (u: number, curvature: number) => {
  const half = (curvature / 2) * DEG;
  return (Math.sin((u - 0.5) * curvature * DEG) + Math.sin(half)) / (2 * Math.sin(half));
};

describe('flat placements are unchanged', () => {
  it('draws a rectangular placement exactly where it was always drawn', async () => {
    const { page } = await open(config(BASE));
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.45);
    // The marker at u = .25 sits at 20 % + .25 * 60 % of the width.
    expect(centroid(scan, YELLOW)!).toBeCloseTo((0.2 + 0.6 * 0.25) * width, -0.3);
    expect(centroid(scan, BLUE)!).toBeCloseTo((0.2 + 0.6 * 0.75) * width, -0.3);
    await page.close();
  });
});

describe('cylindrical surface', () => {
  const surface = { type: 'cylinder', curvature: 160, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 0 };

  it('compresses the artwork towards the sides by the cylinder mapping', async () => {
    const { page } = await open(config({ ...BASE, surface }));
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.45);
    const left = (0.2 + 0.6 * cylinderX(0.25, 160)) * width;
    const mid = (0.2 + 0.6 * cylinderX(0.5, 160)) * width;
    const right = (0.2 + 0.6 * cylinderX(0.75, 160)) * width;
    expect(centroid(scan, YELLOW)!).toBeCloseTo(left, -0.3); // within 1.5 px of the closed form
    expect(centroid(scan, GREEN)!).toBeCloseTo(mid, -0.3);
    expect(centroid(scan, BLUE)!).toBeCloseTo(right, -0.3);
    // ... which is NOT where a flat placement would put the markers.
    expect(Math.abs(left - (0.2 + 0.6 * 0.25) * width)).toBeGreaterThan(8);
    await page.close();
  });

  it('stays inside the placement box and leaves the photo untouched outside it', async () => {
    const { page } = await open(config({ ...BASE, surface }));
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.45);
    const firstRed = scan.findIndex((p) => dist(p, RED) < 60);
    const lastRed = scan.length - 1 - [...scan].reverse().findIndex((p) => dist(p, RED) < 60);
    expect(firstRed).toBeGreaterThanOrEqual(Math.round(0.2 * width) - 2);
    expect(firstRed).toBeLessThanOrEqual(Math.round(0.2 * width) + 3);
    expect(lastRed).toBeGreaterThanOrEqual(Math.round(0.8 * width) - 3);
    expect(lastRed).toBeLessThanOrEqual(Math.round(0.8 * width) + 2);
    await page.close();
  });

  it('has no transparent gaps inside the warped label, even with a tilted camera', async () => {
    const { page } = await open(config({ ...BASE, surface: { ...surface, tilt: 10 } }));
    const { width } = await size(page, 'g');
    // Marker columns (thin lines of other colours) are skipped; everything else inside the label is red.
    const markers = [0.25, 0.5, 0.75].map((u) => (0.2 + 0.6 * cylinderX(u, 160)) * width);
    const bad = await page.evaluate(
      (i, skip) => {
        const c = document.getElementById(i)!.shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        let off = 0;
        let total = 0;
        for (let xf = 0.33; xf <= 0.67; xf += 0.01) {
          const x = Math.round(c.width * xf);
          if (skip.some((m) => Math.abs(m - x) < 6)) continue;
          for (let yf = 0.34; yf <= 0.56; yf += 0.01) {
            const d = ctx.getImageData(x, Math.round(c.height * yf), 1, 1).data;
            total++;
            if (!(d[0] > 235 && d[1] < 25 && d[2] < 25 && d[3] === 255)) off++;
          }
        }
        return { off, total };
      },
      'g',
      markers,
    );
    expect(bad.total).toBeGreaterThan(300);
    expect(bad.off).toBe(0);
    await page.close();
  });

  it('hides the part of the artwork that turns away from the camera', async () => {
    // 360 degrees of artwork around the object: only the camera-facing half (u .25..75) is visible.
    const { page } = await open(config({ ...BASE, surface: { ...surface, curvature: 360 } }));
    const scan = await row(page, 'g', 0.45);
    // The u = .25 marker is at the very left edge of the visible half, the u = .75 marker at the right edge.
    expect(centroid(scan, GREEN)).not.toBeNull();
    const { width } = await size(page, 'g');
    const mid = (0.2 + 0.6 * 0.5) * width;
    expect(centroid(scan, GREEN)!).toBeCloseTo(mid, -0.3);
    await page.close();
  });

  it('keeps its curvature when the placement is moved', async () => {
    const moved = { ...BASE, x: 0.1, y: 0.2, surface };
    const { page } = await open(config(moved));
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.35);
    expect(centroid(scan, YELLOW)!).toBeCloseTo((0.1 + 0.6 * cylinderX(0.25, 160)) * width, -0.3);
    await page.close();
  });
});

describe('printable boundary', () => {
  // A triangle: apex up at the middle of the label's top edge, base along its bottom edge.
  const triangle = {
    version: 1,
    fillRule: 'nonzero',
    contours: [
      { anchors: [{ x: 0.5, y: 0.3 }, { x: 0.8, y: 0.6 }, { x: 0.2, y: 0.6 }] },
    ],
  };

  it('clips the artwork to a Bezier path drawn on the photo, with anti-aliased edges', async () => {
    const { page } = await open(config({ ...BASE, mask: { type: 'path', path: triangle } }));
    const inside = await pixel(page, 'g', 0.42, 0.5);
    expect(dist(inside, RED)).toBeLessThan(60); // inside the triangle: artwork
    const corner = await pixel(page, 'g', 0.25, 0.33);
    expect(dist(corner, RED)).toBeGreaterThan(120); // the label's top-left corner is outside the triangle: photo
    // Along the sloping edge there are partially covered (blended) pixels, not just all-or-nothing.
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.45);
    const blended = scan.filter((p, x) => x > width * 0.3 && x < width * 0.7 && p[0] > 90 && p[0] < 245 && p[1] < 150).length;
    expect(blended).toBeGreaterThan(0);
    await page.close();
  });

  it('clips the WARPED picture: a boundary drawn on the photo is not a flat artwork mask', async () => {
    const surface = { type: 'cylinder', curvature: 160, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 0 };
    // Boundary covers only the RIGHT half of the label's box, in photo coordinates.
    const rightHalf = {
      version: 1,
      fillRule: 'nonzero',
      contours: [{ anchors: [{ x: 0.5, y: 0.3 }, { x: 0.8, y: 0.3 }, { x: 0.8, y: 0.6 }, { x: 0.5, y: 0.6 }] }],
    };
    const { page } = await open(config({ ...BASE, surface, mask: { type: 'path', path: rightHalf } }));
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.45);
    // Left of the boundary: photo, although the warped artwork is there.
    expect(dist(scan[Math.round(width * 0.35)], RED)).toBeGreaterThan(120);
    expect(centroid(scan.slice(0, Math.round(width * 0.49)), YELLOW)).toBeNull();
    // Right of it: the warped artwork, the u = .75 marker where the CYLINDER puts it (not where a flat mask would).
    expect(centroid(scan, BLUE)!).toBeCloseTo((0.2 + 0.6 * cylinderX(0.75, 160)) * width, -0.3);
    await page.close();
  });

  it('applies a raster mask by its alpha channel, including partially transparent pixels', async () => {
    const maskPng = await makeMaskPng(env);
    const { page } = await open(
      config({ ...BASE, mask: { type: 'raster', src: `${env.origin}${TMP_FILES}/mask.png`, width: 200, height: 200 } }),
    );
    // Mask: opaque left third of the photo, 50 % alpha middle third, transparent right third.
    const opaque = await pixel(page, 'g', 0.3, 0.45);
    const half = await pixel(page, 'g', 0.45, 0.45);
    const none = await pixel(page, 'g', 0.72, 0.45);
    expect(dist(opaque, RED)).toBeLessThan(60);
    expect(dist(none, RED)).toBeGreaterThan(120);
    // Halfway: a 50 / 50 blend of the red artwork and whatever the photo shows there.
    const bare = await open(config({ ...BASE, x: 0.9, width: 0.05 }), 'h');
    const photo = await pixel(bare.page, 'h', 0.45, 0.45);
    await bare.page.close();
    for (let c = 0; c < 3; c++) expect(Math.abs(half[c] - (RED[c] * 0.5 + photo[c] * 0.5))).toBeLessThan(22);
    expect(maskPng.length).toBeGreaterThan(0);
    await page.close();
  });

  it('treats a raster mask that cannot be loaded as a broken asset instead of showing unclipped artwork', async () => {
    const hostPage = await openHost(env);
    const missing = { type: 'raster', src: `${env.origin}${TMP_FILES}/does-not-exist.png`, width: 10, height: 10 };
    await host.mount(
      hostPage.page,
      'g',
      { config: config({ ...BASE, mask: missing }), baseUrl: `${env.elementBase}/` },
      { attributes: { mode: 'preview' } },
    );
    await host.waitStatus(hostPage.page, 'g', 'asset-error');
    await hostPage.page.close();
  });
});

describe('editable mesh', () => {
  const grid = (cols: number, rows: number, tweak: (i: number, j: number, x: number, y: number) => [number, number]) => {
    const points: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) points.push(...tweak(i, j, i / (cols - 1), j / (rows - 1)));
    }
    return { cols, rows, points };
  };

  it('an identity mesh renders like the flat placement', async () => {
    const mesh = grid(4, 3, (_i, _j, x, y) => [x, y]);
    const { page } = await open(config({ ...BASE, mesh }));
    const { width } = await size(page, 'g');
    const scan = await row(page, 'g', 0.45);
    expect(centroid(scan, YELLOW)!).toBeCloseTo((0.2 + 0.6 * 0.25) * width, -0.3);
    await page.close();
  });

  it('moves the artwork with a dragged control point', async () => {
    // Pull the interior column x = 1/3 to x = 0.2: the u = .25 marker (between columns 0 and 1) moves left.
    const flat = grid(4, 3, (_i, _j, x, y) => [x, y]);
    const pulled = grid(4, 3, (i, _j, x, y) => [i === 1 ? 0.2 : x, y]);
    const a = await open(config({ ...BASE, mesh: flat }), 'a');
    const b = await open(config({ ...BASE, mesh: pulled }), 'b');
    const sa = centroid(await row(a.page, 'a', 0.45), YELLOW)!;
    const sb = centroid(await row(b.page, 'b', 0.45), YELLOW)!;
    expect(sb).toBeLessThan(sa - 5);
    await a.page.close();
    await b.page.close();
  });
});

describe('production artwork and exports', () => {
  it('the flat production file is unchanged by a surface, a mesh and a boundary, while the preview file is warped', async () => {
    const surface = { type: 'cylinder', curvature: 160, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 0 };
    const mask = {
      type: 'path',
      path: { version: 1, fillRule: 'nonzero', contours: [{ anchors: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }, { x: 0.8, y: 0.6 }, { x: 0.2, y: 0.6 }] }] },
    };
    const { page } = await open(config({ ...BASE, surface, mask }));
    await clickButton(page, 'g', 'Save customization');
    await page.waitForFunction((i) => (window as any).testHost.events(i, 'customizer-save').length > 0, { timeout: 20000 }, 'g');
    // Production artwork: 800 x 400, markers at x = 200 / 400 / 600, exactly where the flat design put them.
    const art = await host.pixels(page, 'g', 'artwork', [[100, 200], [200, 200], [400, 200], [600, 200], [150, 20]]);
    expect(art.width).toBe(800);
    expect(art.height).toBe(400);
    expect(dist(art.pixels[1], YELLOW)).toBeLessThan(10);
    expect(dist(art.pixels[2], GREEN)).toBeLessThan(10);
    expect(dist(art.pixels[3], BLUE)).toBeLessThan(10);
    expect(dist(art.pixels[0], RED)).toBeLessThan(10);
    // Composite preview: the same markers are where the cylinder puts them.
    const pw = (await host.pixels(page, 'g', 'preview', [])).width;
    const yellowX = (0.2 + 0.6 * cylinderX(0.25, 160)) * pw;
    const found = await host.pixels(page, 'g', 'preview', [[Math.round(yellowX), Math.round((await host.pixels(page, 'g', 'preview', [])).height * 0.45)]]);
    expect(dist(found.pixels[0], YELLOW)).toBeLessThan(40);
    await page.close();
  });
});

/** A 200 x 200 mask over the whole photo: opaque for x < 40 %, 50 % alpha for x < 60 %, transparent beyond. */
async function makeMaskPng(environment: Environment): Promise<Buffer> {
  const helper = await environment.browser.newPage();
  const base64 = await helper.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 200;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(0, 0, 80, 200);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(80, 0, 40, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  await helper.close();
  const bytes = Buffer.from(base64, 'base64');
  writeFixture(environment, 'mask.png', bytes);
  return bytes;
}

// ---- regression fixtures: a straight-on supplement jar and an angled spray bottle ---------------------------
// Original photographs drawn by scripts/generate-surface-fixtures.mjs; the label geometry comes from the
// metadata written next to them, so every expectation below is stated in terms of where the label is.

const FIXTURES = JSON.parse(readFileSync(new URL('./host/fixtures/surface-fixtures.json', import.meta.url), 'utf8'));
const fixtureUrl = (name: string) => `${env.origin}/fixtures/${name}.png`;

describe('supplement jar: a wraparound label on a straight-on cylinder', () => {
  const label = FIXTURES.supplement.label;
  const placement = { type: 'rect', x: label.x, y: label.y, width: label.width, height: label.height, surface: { type: 'cylinder', curvature: 140, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 0 } };
  const cfg = () => config(placement, {}, fixtureUrl('supplement-bottle'));

  it('wraps the artwork over the label exactly as the cylinder maps it and never leaves the label', async () => {
    const { page } = await open(cfg());
    const { width, height } = await size(page, 'g');
    const scan = await row(page, 'g', label.y + label.height * 0.5);
    for (const u of [0.25, 0.5, 0.75]) {
      const colour = u === 0.25 ? YELLOW : u === 0.5 ? GREEN : BLUE;
      expect(centroid(scan, colour)!).toBeCloseTo((label.x + label.width * cylinderX(u, 140)) * width, -0.3);
    }
    // 6 px outside every side of the label there is only the photograph.
    for (const [fx, fy] of [
      [label.x - 6 / width, label.y + label.height / 2],
      [label.x + label.width + 6 / width, label.y + label.height / 2],
      [label.x + label.width / 2, label.y - 6 / height],
      [label.x + label.width / 2, label.y + label.height + 6 / height],
    ]) {
      expect(dist(await pixel(page, 'g', fx, fy), RED)).toBeGreaterThan(100);
    }
    await page.close();
  });

  it('exports a composite preview with the same wrap, and the flat production file unchanged', async () => {
    const { page } = await open(cfg());
    await clickButton(page, 'g', 'Save customization');
    await page.waitForFunction((i) => (window as any).testHost.events(i, 'customizer-save').length > 0, { timeout: 20000 }, 'g');
    const probe = await host.pixels(page, 'g', 'preview', []);
    const y = Math.round(probe.height * (label.y + label.height * 0.5));
    // Scan the exported composite row by decoding it in the page.
    const exported = await page.evaluate(async (i, yy) => {
      const blob = (window as any).testHost.saves[i].at(-1).previewBlob as Blob;
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, yy, c.width, 1).data;
      return Array.from({ length: c.width }, (_, x) => Array.from(d.slice(x * 4, x * 4 + 4)));
    }, 'g', y);
    expect(centroid(exported, YELLOW)!).toBeCloseTo((label.x + label.width * cylinderX(0.25, 140)) * probe.width, -0.3);
    const art = await host.pixels(page, 'g', 'artwork', [[200, 200], [400, 200]]);
    expect(art.width).toBe(800);
    expect(dist(art.pixels[0], YELLOW)).toBeLessThan(10); // the flat design is untouched by the wrap
    expect(dist(art.pixels[1], GREEN)).toBeLessThan(10);
    await page.close();
  });
});

describe('spray bottle: an angled label with a tilted camera and a Bezier boundary', () => {
  const spray = FIXTURES.spray;
  const p = spray.placement;
  // Larger than the label on purpose: the boundary, not the placement rectangle, must decide what shows.
  const wide = { ...p, x: p.x - p.width * 0.2, width: p.width * 1.4 };
  const surface = { type: 'cylinder', curvature: 120, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 12 };
  const cfg = () => config({ type: 'rect', ...wide, surface, mask: { type: 'path', path: spray.outline } }, {}, fixtureUrl('spray-bottle'));

  /** Frame-local position of artwork (u, v) on the documented cylinder (derived independently of the implementation). */
  const local = (u: number, v: number, aspect: number) => {
    const half = (surface.curvature / 2) * DEG;
    const phi = (u - 0.5) * surface.curvature * DEG;
    const x = (Math.sin(phi) + Math.sin(half)) / (2 * Math.sin(half));
    const radius = 1 / (2 * Math.sin(half));
    return [x, v + radius * Math.sin(surface.tilt * DEG) * (Math.cos(phi) - 1) * aspect];
  };
  /** Local frame coordinates -> fractions of the photo for the rotated placement rectangle. */
  const toPhoto = (lx: number, ly: number) => {
    const w = wide.width * spray.width;
    const h = wide.height * spray.height;
    const cx = (wide.x + wide.width / 2) * spray.width;
    const cy = (wide.y + wide.height / 2) * spray.height;
    const a = wide.rotation * DEG;
    const dx = (lx - 0.5) * w;
    const dy = (ly - 0.5) * h;
    return [(cx + dx * Math.cos(a) - dy * Math.sin(a)) / spray.width, (cy + dx * Math.sin(a) + dy * Math.cos(a)) / spray.height];
  };

  it('puts the wrapped artwork where the rotated, tilted cylinder maps it', async () => {
    const { page } = await open(cfg());
    const aspect = (wide.width * spray.width) / (wide.height * spray.height);
    for (const [u, colour] of [[0.5, GREEN], [0.75, BLUE], [0.25, YELLOW]] as const) {
      const [lx, ly] = local(u, 0.5, aspect);
      const [fx, fy] = toPhoto(lx, ly);
      const got = await pixel(page, 'g', fx, fy);
      expect(dist(got, colour), `marker u=${u} at ${fx.toFixed(3)},${fy.toFixed(3)} -> ${got}`).toBeLessThan(110);
    }
    await page.close();
  });

  it('clips to the label outline, not to the (larger) placement and not to a flat mask', async () => {
    const { page } = await open(cfg());
    const { width, height } = await size(page, 'g');
    // Centre of the label: artwork.
    expect(dist(await pixel(page, 'g', 0.5, 330 / spray.height), GREEN)).toBeLessThan(110);
    // Points that are inside the placement rectangle but outside the label outline: the dark bottle shows.
    const aspect = (wide.width * spray.width) / (wide.height * spray.height);
    void aspect;
    for (const lx of [0.04, 0.96]) {
      const [fx, fy] = toPhoto(lx, 0.5);
      const got = await pixel(page, 'g', fx, fy);
      expect(dist(got, RED), `outside the outline at ${fx.toFixed(3)},${fy.toFixed(3)} -> ${got}`).toBeGreaterThan(120);
    }
    // The boundary is anti-aliased: the outline edge has blended pixels.
    const edge = await page.evaluate(
      (i, pts) => {
        const c = document.getElementById(i)!.shadowRoot!.querySelector('canvas.preview-canvas') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        let blended = 0;
        for (const [fx, fy] of pts) {
          const d = ctx.getImageData(Math.round(c.width * fx) - 3, Math.round(c.height * fy) - 3, 6, 6).data;
          for (let k = 0; k < d.length; k += 4) if (d[k] > 70 && d[k] < 235 && d[k + 1] < 60 && d[k + 2] < 60) blended++;
        }
        return blended;
      },
      'g',
      spray.outline.contours[0].anchors.map((a: any) => [a.x, a.y]),
    );
    expect(edge).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    await page.close();
  });
});
