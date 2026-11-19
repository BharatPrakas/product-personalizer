import { describe, expect, it } from 'vitest';
import type { AreaPlacement, CylinderSurface, MeshSpec } from '../models/product.models';
import {
  DEFAULT_CYLINDER,
  buildWarpGrid,
  clampCylinder,
  cylinderInverseU,
  cylinderLocal,
  cylinderSpan,
  gridBounds,
  meshFolds,
  meshFromSurface,
  meshLocal,
  moveMeshPoint,
  offsetMesh,
  placementFrame,
  resampleMesh,
} from './surface';

const cyl = (patch: Partial<CylinderSurface> = {}): CylinderSurface => ({
  ...DEFAULT_CYLINDER,
  ...patch,
});
const rect = (patch: Partial<AreaPlacement> = {}): AreaPlacement => ({
  printableAreaId: 'a',
  type: 'rect',
  x: 0.25,
  y: 0.25,
  width: 0.5,
  height: 0.5,
  ...patch,
});

describe('cylinder mapping', () => {
  it('is the identity at zero curvature', () => {
    const s = cyl({ curvature: 0 });
    for (const [u, v] of [
      [0, 0],
      [0.3, 0.7],
      [1, 1],
    ]) {
      expect(cylinderLocal(s, u, v, 1)).toEqual([u, v]);
    }
  });

  it('is symmetric: the artwork centre lands mid-box and the ends land on the box edges', () => {
    const s = cyl({ curvature: 120 });
    const mid = cylinderLocal(s, 0.5, 0.5, 1)!;
    expect(mid[0]).toBeCloseTo(0.5, 12);
    expect(cylinderLocal(s, 0, 0, 1)![0]).toBeCloseTo(0, 12);
    expect(cylinderLocal(s, 1, 0, 1)![0]).toBeCloseTo(1, 12);
    // Mirror symmetry: x(0.5 - d) + x(0.5 + d) = 1
    for (const d of [0.1, 0.25, 0.4]) {
      const a = cylinderLocal(s, 0.5 - d, 0, 1)![0];
      const b = cylinderLocal(s, 0.5 + d, 0, 1)![0];
      expect(a + b).toBeCloseTo(1, 12);
    }
  });

  it('compresses the artwork towards the sides by cos(angle), not linearly', () => {
    const s = cyl({ curvature: 120 });
    const du = 1e-5;
    const slope = (u: number) =>
      (cylinderLocal(s, u + du, 0, 1)![0] - cylinderLocal(s, u - du, 0, 1)![0]) / (2 * du);
    // At the edge the surface is 60 degrees off-axis: slope ratio edge/centre = cos(60) = 0.5.
    expect(slope(1 - 2 * du) / slope(0.5)).toBeCloseTo(0.5, 3);
    // Strictly increasing from left to right (no folding back).
    let last = -Infinity;
    for (let i = 0; i <= 50; i++) {
      const x = cylinderLocal(s, i / 50, 0, 1)![0];
      expect(x).toBeGreaterThan(last);
      last = x;
    }
  });

  it('round-trips through the inverse', () => {
    const s = cyl({ curvature: 200, centre: 15, visibleLeft: 70, visibleRight: 80 });
    const span = cylinderSpan(s)!;
    for (let i = 0; i <= 10; i++) {
      const u = span.uMin + ((span.uMax - span.uMin) * i) / 10;
      const x = cylinderLocal(s, u, 0, 1)![0];
      expect(cylinderInverseU(s, x)).toBeCloseTo(u, 9);
    }
  });

  it('hides the part of the artwork that turns away from the camera (wrap extents)', () => {
    // 360 degrees of artwork: only the half that faces the camera is visible.
    const full = cylinderSpan(cyl({ curvature: 360 }))!;
    expect(full.uMin).toBeCloseTo(0.25, 12);
    expect(full.uMax).toBeCloseTo(0.75, 12);
    expect(cylinderLocal(cyl({ curvature: 360 }), 0.1, 0, 1)).toBeNull();
    expect(cylinderLocal(cyl({ curvature: 360 }), 0.9, 0, 1)).toBeNull();
    // Asymmetric visible extents: 30 degrees visible to the left, 90 to the right.
    const asym = cylinderSpan(cyl({ curvature: 180, visibleLeft: 30, visibleRight: 90 }))!;
    expect(asym.phiStart).toBeCloseTo(-30, 12);
    expect(asym.uMin).toBeCloseTo(0.5 - 30 / 180, 12);
    expect(asym.uMax).toBeCloseTo(1, 12);
    // Reducing the right extent trims the right side too.
    const narrower = cylinderSpan(cyl({ curvature: 180, visibleLeft: 90, visibleRight: 45 }))!;
    expect(narrower.uMax).toBeCloseTo(0.5 + 45 / 180, 12);
  });

  it('rotating the artwork around the object moves its centre off the middle and clips one side', () => {
    const s = cyl({ curvature: 120, centre: 30 }); // artwork spans -30..90 degrees
    const span = cylinderSpan(s)!;
    expect(span.phiStart).toBeCloseTo(-30, 12);
    expect(span.phiEnd).toBeCloseTo(90, 12);
    // The artwork centre (30 degrees right of the camera axis) lies right of the box middle.
    expect(cylinderLocal(s, 0.5, 0, 1)![0]).toBeGreaterThan(0.5);
    const far = cyl({ curvature: 120, centre: 100 }); // spans 40..160 -> visible 40..90 only
    const farSpan = cylinderSpan(far)!;
    expect(farSpan.phiStart).toBeCloseTo(40, 12);
    expect(farSpan.phiEnd).toBeCloseTo(90, 12);
  });

  it('returns nothing when no part of the artwork is visible', () => {
    expect(cylinderSpan(cyl({ curvature: 20, centre: 170 }))).toBeNull();
    expect(
      buildWarpGrid(rect({ surface: cyl({ curvature: 20, centre: 170 }) }), 1000, 800, 1),
    ).toBeNull();
  });

  it('bows horizontal edges with camera tilt, and only away from the camera-facing meridian', () => {
    const flatLine = cyl({ curvature: 120, tilt: 0 });
    expect(cylinderLocal(flatLine, 0.1, 0.25, 1)![1]).toBeCloseTo(0.25, 12);
    const tilted = cyl({ curvature: 120, tilt: 30 });
    const front = cylinderLocal(tilted, 0.5, 0, 1)![1];
    const side = cylinderLocal(tilted, 0, 0, 1)![1];
    expect(front).toBeCloseTo(0, 12); // no displacement on the camera-facing meridian
    expect(side).toBeLessThan(front); // looking down: the sides sit higher (smile-shaped edges)
    // The opposite tilt flips the bow.
    expect(cylinderLocal(cyl({ curvature: 120, tilt: -30 }), 0, 0, 1)![1]).toBeCloseTo(-side, 12);
    // The bow does not depend on v (every row is bent the same way).
    expect(cylinderLocal(tilted, 0, 1, 1)![1] - cylinderLocal(tilted, 0, 0, 1)![1]).toBeCloseTo(
      1,
      12,
    );
  });

  it('clamps editor input into the documented ranges', () => {
    const c = clampCylinder(
      cyl({ curvature: 900, centre: -400, visibleLeft: 0, visibleRight: 500, tilt: 99 }),
    );
    expect(c).toMatchObject({
      curvature: 360,
      centre: -180,
      visibleLeft: 1,
      visibleRight: 90,
      tilt: 60,
    });
  });
});

describe('mesh', () => {
  const identity = (cols: number, rows: number): MeshSpec =>
    meshFromSurface(undefined, 1, cols, rows);

  it('starts as the identity and interpolates linearly through two control points', () => {
    const m = identity(2, 2);
    for (const [u, v] of [
      [0, 0],
      [0.25, 0.75],
      [1, 1],
    ]) {
      const p = meshLocal(m, u, v);
      expect(p[0]).toBeCloseTo(u, 12);
      expect(p[1]).toBeCloseTo(v, 12);
    }
    const dense = identity(5, 4);
    const p = meshLocal(dense, 0.37, 0.61);
    // Control points are stored to 6 decimals, so the identity holds to that precision.
    expect(p[0]).toBeCloseTo(0.37, 5);
    expect(p[1]).toBeCloseTo(0.61, 5);
  });

  it('passes exactly through every control point, so dragging one moves exactly that point', () => {
    let m = identity(4, 4);
    m = moveMeshPoint(m, 5, [0.4, 0.2]); // column 1, row 1
    const p = meshLocal(m, 1 / 3, 1 / 3);
    expect(p[0]).toBeCloseTo(0.4, 6);
    expect(p[1]).toBeCloseTo(0.2, 6);
  });

  it('moves smoothly: a moved point drags its neighbourhood, not just a single cell', () => {
    let m = identity(5, 5);
    m = moveMeshPoint(m, 12, [0.5, 0.3]); // centre point up
    // Between the moved point (y 0.3) and its upper neighbour (0.25) the surface follows it ...
    const between = meshLocal(m, 0.5, 0.375)[1];
    expect(between).toBeLessThan(0.375);
    expect(between).toBeGreaterThan(0.25);
    // ... and one cell further out the surface is still pulled (smooth, not a single-cell tent).
    expect(meshLocal(m, 0.5, 0.125)[1]).toBeGreaterThan(0.125);
  });

  it('translates every point', () => {
    const m = offsetMesh(identity(3, 3), 0.1, -0.2);
    expect(m.points.slice(0, 2)).toEqual([0.1, -0.2]);
    expect(m.points.slice(-2)).toEqual([1.1, 0.8]);
  });

  it('samples a cylinder so its shape survives the conversion to a mesh', () => {
    const s = cyl({ curvature: 140, tilt: 25 });
    const m = meshFromSurface(s, 1.4, 9, 3);
    for (const u of [0.1, 0.33, 0.5, 0.8]) {
      const exact = cylinderLocal(s, u, 0.5, 1.4)!;
      const approx = meshLocal(m, u, 0.5);
      expect(approx[0]).toBeCloseTo(exact[0], 2);
      expect(approx[1]).toBeCloseTo(exact[1], 2);
    }
  });

  it('keeps its shape when the density changes', () => {
    const m = meshFromSurface(cyl({ curvature: 120 }), 1, 7, 3);
    const finer = resampleMesh(m, 11, 5);
    expect(finer.points).toHaveLength(11 * 5 * 2);
    for (const [u, v] of [
      [0.2, 0.3],
      [0.5, 0.5],
      [0.9, 0.8],
    ]) {
      const a = meshLocal(m, u, v);
      const b = meshLocal(finer, u, v);
      expect(b[0]).toBeCloseTo(a[0], 2);
      expect(b[1]).toBeCloseTo(a[1], 2);
    }
  });

  it('accepts unfolded meshes and reports folded or collapsed cells', () => {
    expect(meshFolds(identity(4, 4))).toEqual([]);
    expect(meshFolds(meshFromSurface(cyl({ curvature: 160 }), 1, 6, 3))).toEqual([]);
    // Drag the centre point past its neighbour on the other side: the surface turns inside out.
    const folded = moveMeshPoint(identity(3, 3), 4, [-0.4, 0.5]);
    expect(meshFolds(folded).length).toBeGreaterThan(0);
    // Pull two neighbouring points onto each other: a cell collapses to a line.
    let collapsed = identity(3, 3);
    collapsed = moveMeshPoint(collapsed, 0, [0.5, 0]);
    collapsed = moveMeshPoint(collapsed, 3, [0.5, 0.5]);
    collapsed = moveMeshPoint(collapsed, 1, [0.5, 0]);
    collapsed = moveMeshPoint(collapsed, 4, [0.5, 0.5]);
    expect(meshFolds(collapsed).length).toBeGreaterThan(0);
  });
});

describe('placement frame and warp grid', () => {
  it('maps frame-local coordinates through a rotated rectangle', () => {
    const f = placementFrame(rect({ x: 0, y: 0, width: 0.5, height: 0.25 }), 1000, 800, 1)!;
    expect(f.aspect).toBeCloseTo(500 / 200, 12);
    expect(f.toPixels(0, 0)).toEqual([0, 0]);
    expect(f.toPixels(1, 1)).toEqual([500, 200]);
    const r = placementFrame(
      rect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 90 }),
      800,
      800,
      1,
    )!;
    const [px, py] = r.toPixels(0, 0); // top-left corner of a 90-degree rotated square
    expect(px).toBeCloseTo(600, 9);
    expect(py).toBeCloseTo(200, 9);
  });

  it('maps frame-local coordinates through a perspective quad', () => {
    const quad = rect({
      type: 'quad',
      corners: [
        [0.1, 0.2],
        [0.9, 0.1],
        [0.8, 0.9],
        [0.2, 0.8],
      ],
    });
    const f = placementFrame(quad, 1000, 1000, 1.5)!;
    expect(f.aspect).toBe(1.5);
    for (const [[lx, ly], [ex, ey]] of [
      [
        [0, 0],
        [100, 200],
      ],
      [
        [1, 0],
        [900, 100],
      ],
      [
        [1, 1],
        [800, 900],
      ],
      [
        [0, 1],
        [200, 800],
      ],
    ] as const) {
      const [px, py] = f.toPixels(lx, ly);
      expect(px).toBeCloseTo(ex, 6);
      expect(py).toBeCloseTo(ey, 6);
    }
  });

  it('inverts the frame mapping for rotated rectangles and perspective quads', () => {
    const frames = [
      placementFrame(
        rect({ x: 0.1, y: 0.2, width: 0.4, height: 0.3, rotation: 33 }),
        1000,
        800,
        1,
      )!,
      placementFrame(
        rect({
          type: 'quad',
          corners: [
            [0.1, 0.2],
            [0.9, 0.1],
            [0.8, 0.9],
            [0.2, 0.8],
          ],
        }),
        1000,
        800,
        1.5,
      )!,
    ];
    for (const f of frames) {
      for (const [x, y] of [
        [0, 0],
        [1, 1],
        [0.3, 0.7],
        [-0.2, 1.3],
      ]) {
        const [px, py] = f.toPixels(x, y);
        const back = f.fromPixels(px, py)!;
        expect(back[0]).toBeCloseTo(x, 6);
        expect(back[1]).toBeCloseTo(y, 6);
      }
    }
  });

  it('builds a grid that stays inside the visible bounds and is independent of the artwork pixels', () => {
    const grid = buildWarpGrid(rect({ surface: cyl({ curvature: 140 }) }), 1000, 800, 1.2, {
      detail: 1,
    })!;
    const b = gridBounds(grid);
    expect(b.x).toBeCloseTo(250, 6);
    expect(b.x + b.width).toBeCloseTo(750, 6);
    expect(b.y).toBeCloseTo(200, 6);
    expect(b.y + b.height).toBeCloseTo(600, 6);
    expect(grid.rows).toBe(2);
    // u runs over the visible range only and v over 0..1.
    expect(grid.u[0]).toBeCloseTo(0.5 - 70 / 140, 12);
    expect(grid.v[0]).toBe(0);
    expect(grid.v[grid.cols]).toBe(1);
  });

  it('returns no grid for a plain placement, and uses the mesh when one is present', () => {
    expect(buildWarpGrid(rect(), 1000, 800, 1)).toBeNull();
    const mesh = meshFromSurface(undefined, 1, 4, 3);
    const grid = buildWarpGrid(rect({ mesh }), 1000, 800, 1)!;
    expect(grid.cols).toBeGreaterThan(4);
    const b = gridBounds(grid);
    expect(b.width).toBeCloseTo(500, 6);
  });

  it('moving the placement moves the mesh with it (the mesh is frame-relative)', () => {
    const mesh = moveMeshPoint(meshFromSurface(undefined, 1, 3, 3), 4, [0.6, 0.4]);
    const a = gridBounds(buildWarpGrid(rect({ mesh }), 1000, 800, 1)!);
    const b = gridBounds(buildWarpGrid(rect({ mesh, x: 0.3, y: 0.1 }), 1000, 800, 1)!);
    expect(b.x - a.x).toBeCloseTo(50, 6);
    expect(b.y - a.y).toBeCloseTo(-120, 6);
    expect(b.width).toBeCloseTo(a.width, 6);
    // Resizing scales it.
    const c = gridBounds(buildWarpGrid(rect({ mesh, width: 0.25, height: 0.25 }), 1000, 800, 1)!);
    expect(c.width).toBeCloseTo(a.width / 2, 6);
  });
});
