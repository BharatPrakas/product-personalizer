import { describe, expect, it } from 'vitest';
import type { AreaPlacement } from '../models/product.models';
import {
  DEFAULT_CYLINDER,
  WarpGrid,
  buildWarpGrid,
  gridBounds,
  meshFromSurface,
  moveMeshPoint,
} from './surface';
import { PixelImage, rasterizeWarp } from './warp';

function solid(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

/** Horizontal ramp: red channel = column index scaled to 0..255, fully opaque. */
function ramp(width: number, height: number): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([Math.round((x / (width - 1)) * 255), 0, 0, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const placement = (patch: Partial<AreaPlacement>): AreaPlacement => ({
  printableAreaId: 'a',
  type: 'rect',
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.8,
  ...patch,
});

function pixel(img: PixelImage, x: number, y: number): number[] {
  return Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
}

/** A hand-made grid covering a rotated parallelogram, for exact coverage checks. */
function parallelogramGrid(): WarpGrid {
  const cols = 9;
  const rows = 6;
  const g: WarpGrid = {
    cols,
    rows,
    x: new Float64Array(cols * rows),
    y: new Float64Array(cols * rows),
    u: new Float64Array(cols * rows),
    v: new Float64Array(cols * rows),
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const v = j / (rows - 1);
      const k = j * cols + i;
      g.u[k] = u;
      g.v[k] = v;
      g.x[k] = 6.3 + u * 38.7 + v * 7.1;
      g.y[k] = 4.4 + v * 30.2 + u * 5.9;
    }
  }
  return g;
}

describe('rasterizer', () => {
  it('reproduces the source exactly for an identity mapping at 1:1', () => {
    const src = ramp(16, 8);
    const grid: WarpGrid = {
      cols: 2,
      rows: 2,
      x: Float64Array.of(0, 16, 0, 16),
      y: Float64Array.of(0, 0, 8, 8),
      u: Float64Array.of(0, 1, 0, 1),
      v: Float64Array.of(0, 0, 1, 1),
    };
    const out = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 16,
      height: 8,
    });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('keeps 50 % transparent artwork at exactly 50 % everywhere inside: no seams, no double blending', () => {
    // The perspective renderer's triangle drawing measured alpha 93..130 (gaps) and up to 252
    // (overlap) on this input; the rasterizer must give one value for every covered pixel.
    const src = solid(64, 64, [255, 0, 0, 128]);
    const grid = parallelogramGrid();
    const out = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
    });
    const alphas = new Set<number>();
    let covered = 0;
    for (let i = 0; i < out.width * out.height; i++) {
      const a = out.data[i * 4 + 3];
      if (a === 0) continue;
      covered++;
      alphas.add(a);
      expect(Array.from(out.data.slice(i * 4, i * 4 + 3))).toEqual([255, 0, 0]);
    }
    expect([...alphas]).toEqual([128]);
    // The covered area equals the parallelogram's area (38.7*30.2 - 7.1*5.9 = 1126.9) within the edge pixels.
    expect(Math.abs(covered - (38.7 * 30.2 - 7.1 * 5.9))).toBeLessThan(40);
  });

  it('covers every pixel centre inside the outline exactly once (no gaps)', () => {
    const src = solid(32, 32, [0, 0, 0, 255]);
    const grid = parallelogramGrid();
    const out = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
    });
    const corners = [
      [grid.x[0], grid.y[0]],
      [grid.x[8], grid.y[8]],
      [grid.x[53], grid.y[53]],
      [grid.x[45], grid.y[45]],
    ];
    const inside = (px: number, py: number) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
        if (Math.abs(c) < 1e-6) return null; // too close to call
        if (sign === 0) sign = Math.sign(c);
        else if (sign !== Math.sign(c)) return false;
      }
      return true;
    };
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const expected = inside(x + 0.5, y + 0.5);
        if (expected === null) continue;
        expect(out.data[(y * out.width + x) * 4 + 3] > 0, `pixel ${x},${y}`).toBe(expected);
      }
    }
  });

  it('is deterministic', () => {
    const src = ramp(40, 40);
    const grid = parallelogramGrid();
    const a = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
    });
    const b = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
    });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('supersampling anti-aliases the silhouette and leaves the interior untouched', () => {
    const src = solid(32, 32, [0, 255, 0, 255]);
    const grid = parallelogramGrid();
    const hard = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
    });
    const soft = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
      supersample: 3,
    });
    expect(
      new Set(Array.from({ length: hard.width * hard.height }, (_, i) => hard.data[i * 4 + 3])),
    ).toEqual(new Set([0, 255]));
    const partial = Array.from(
      { length: soft.width * soft.height },
      (_, i) => soft.data[i * 4 + 3],
    ).filter((a) => a > 0 && a < 255);
    expect(partial.length).toBeGreaterThan(40);
    expect(pixel(soft, 25, 20)).toEqual([0, 255, 0, 255]);
    // Colour of partially covered pixels is not darkened by the transparent surround (un-premultiplied).
    for (let i = 0; i < soft.width * soft.height; i++) {
      if (soft.data[i * 4 + 3] > 0) expect(soft.data[i * 4 + 1]).toBe(255);
    }
  });

  it('keeps the exact colour at every supersampling level (interior and anti-aliased edge)', () => {
    // Mid-tone, so a wrong un-premultiply (the factor of n once slipped in) cannot hide behind clamping.
    const src = solid(32, 32, [100, 150, 200, 255]);
    for (const supersample of [1, 2, 3, 4] as const) {
      const out = rasterizeWarp({
        grid: parallelogramGrid(),
        source: src,
        scale: 1,
        originX: 0,
        originY: 0,
        width: 60,
        height: 50,
        supersample,
      });
      let edge = 0;
      for (let i = 0; i < out.width * out.height; i++) {
        const a = out.data[i * 4 + 3];
        if (a === 0) continue;
        if (a < 255) edge++;
        expect(
          Array.from(out.data.slice(i * 4, i * 4 + 3)),
          `ss ${supersample}, pixel ${i}`,
        ).toEqual([100, 150, 200]);
      }
      if (supersample > 1) expect(edge).toBeGreaterThan(20);
    }
    // And a translucent source keeps its alpha through the box filter.
    const glass = solid(32, 32, [90, 40, 160, 128]);
    const out = rasterizeWarp({
      grid: parallelogramGrid(),
      source: glass,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 60,
      height: 50,
      supersample: 2,
    });
    // 8-bit premultiplied storage costs at most one level of colour at half alpha.
    const px = pixel(out, 25, 20);
    expect(px[3]).toBe(128);
    [90, 40, 160].forEach((v, c) => expect(Math.abs(px[c] - v)).toBeLessThanOrEqual(1));
  });

  it('maps a cylinder: the centre of the artwork is stretched, the sides are compressed', () => {
    const W = 400;
    const H = 200;
    const src = ramp(256, 16);
    const grid = buildWarpGrid(
      placement({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        surface: { ...DEFAULT_CYLINDER, curvature: 160 },
      }),
      W,
      H,
      16,
    )!;
    const out = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: W,
      height: H,
    });
    // Red = source column fraction. Mid-box shows the artwork centre.
    expect(pixel(out, W / 2, H / 2)[0]).toBeGreaterThanOrEqual(126);
    expect(pixel(out, W / 2, H / 2)[0]).toBeLessThanOrEqual(129);
    // Near the left edge a 10 px step covers MORE artwork than the same step in the middle.
    const edgeStep = pixel(out, 14, 100)[0] - pixel(out, 4, 100)[0];
    const midStep = pixel(out, W / 2 + 5, 100)[0] - pixel(out, W / 2 - 5, 100)[0];
    expect(edgeStep).toBeGreaterThan(midStep * 1.5);
    // Closed-form check at one point: x = 100 px -> u from the inverse cylinder.
    const phi0 = Math.asin(
      Math.sin((-80 * Math.PI) / 180) + (100 / W) * 2 * Math.sin((80 * Math.PI) / 180),
    );
    const u = 0.5 + (phi0 * 180) / Math.PI / 160;
    expect(pixel(out, 100, 100)[0]).toBeCloseTo(u * 255, -0.5);
  });

  it('leaves no transparent gaps inside a bowed cylinder, even with a high tilt', () => {
    const src = solid(100, 40, [10, 20, 30, 255]);
    const grid = buildWarpGrid(
      placement({ surface: { ...DEFAULT_CYLINDER, curvature: 200, tilt: 40 } }),
      300,
      200,
      2.5,
    )!;
    const out = rasterizeWarp({
      grid,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: 300,
      height: 200,
    });
    // For every column that has any ink, the covered rows must be one unbroken run.
    for (let x = 0; x < out.width; x++) {
      let runs = 0;
      let inRun = false;
      for (let y = 0; y < out.height; y++) {
        const on = out.data[(y * out.width + x) * 4 + 3] > 0;
        if (on && !inRun) runs++;
        inRun = on;
      }
      expect(runs, `column ${x}`).toBeLessThanOrEqual(1);
    }
  });

  it('renders a mesh and follows a dragged control point', () => {
    const W = 200;
    const H = 200;
    const src = ramp(100, 100);
    const base = meshFromSurface(undefined, 1, 4, 4);
    const grid0 = buildWarpGrid(
      placement({ x: 0, y: 0, width: 1, height: 1, mesh: base }),
      W,
      H,
      1,
    )!;
    const moved = moveMeshPoint(base, 5, [0.2, 0.2]); // column 1, row 1 pulled toward the corner
    const grid1 = buildWarpGrid(
      placement({ x: 0, y: 0, width: 1, height: 1, mesh: moved }),
      W,
      H,
      1,
    )!;
    const a = rasterizeWarp({
      grid: grid0,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: W,
      height: H,
    });
    const b = rasterizeWarp({
      grid: grid1,
      source: src,
      scale: 1,
      originX: 0,
      originY: 0,
      width: W,
      height: H,
    });
    // The artwork column u = 1/3 (red ~85) now sits near x = 0.2 * 200 = 40 instead of 66.
    const find = (img: PixelImage) => {
      let best = 0;
      for (let x = 0; x < W; x++)
        if (
          Math.abs(img.data[(40 * W + x) * 4] - 85) < Math.abs(img.data[(40 * W + best) * 4] - 85)
        )
          best = x;
      return best;
    };
    void gridBounds;
    expect(Math.abs(find(a) - 200 / 3)).toBeLessThan(3);
    expect(Math.abs(find(b) - 40)).toBeLessThan(9);
  });

  it('keeps the original pixels when scaled up (output scale > 1) and respects the output origin', () => {
    const src = solid(8, 8, [200, 100, 50, 255]);
    const grid: WarpGrid = {
      cols: 2,
      rows: 2,
      x: Float64Array.of(10, 18, 10, 18),
      y: Float64Array.of(10, 10, 18, 18),
      u: Float64Array.of(0, 1, 0, 1),
      v: Float64Array.of(0, 0, 1, 1),
    };
    const out = rasterizeWarp({
      grid,
      source: src,
      scale: 2,
      originX: 20,
      originY: 20,
      width: 16,
      height: 16,
    });
    expect(pixel(out, 0, 0)).toEqual([200, 100, 50, 255]);
    expect(pixel(out, 15, 15)).toEqual([200, 100, 50, 255]);
    const shifted = rasterizeWarp({
      grid,
      source: src,
      scale: 2,
      originX: 24,
      originY: 24,
      width: 16,
      height: 16,
    });
    // Shifting the origin by 4 px moves the picture 4 px up and to the left.
    expect(pixel(shifted, 11, 11)).toEqual([200, 100, 50, 255]);
    expect(pixel(shifted, 12, 12)).toEqual([0, 0, 0, 0]);
    expect(pixel(shifted, 0, 0)).toEqual([200, 100, 50, 255]);
  });
});
