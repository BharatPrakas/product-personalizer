/**
 * Surface transformations for a placement: how the flat production artwork is bent onto the object
 * in the photograph. Pure maths, no canvas.
 *
 * The pipeline for one artwork point `(u, v)` (fractions of the flat artwork, origin top-left):
 *
 *   artwork (u, v)  --surface-->  frame-local (x, y)  --frame-->  mockup pixels
 *
 *  - `surface` is the cylinder (`cylinderLocal`) or a free mesh (`meshLocal`), or the identity.
 *  - The frame is the placement itself: a rotated rectangle, or a four-corner perspective quad.
 *    Frame-local `(0,0)` is the frame's top-left and `(1,1)` its bottom-right, so everything the
 *    surface does is relative to the placement and survives moving, resizing and rotating it.
 *
 * Nothing here touches the production artwork: the flat canvas stays the source of truth.
 */

import type { AreaPlacement, CylinderSurface, MeshSpec, Point } from '../models/product.models';
import { MESH_LIMITS, SURFACE_LIMITS } from '../models/product.models';
import { DEG } from './geometry';
import { projectSquare, squareToQuad, unprojectSquare } from './homography';

export type Vec = readonly [x: number, y: number];

// ---- cylinder ------------------------------------------------------------------------------------

export const DEFAULT_CYLINDER: CylinderSurface = {
  type: 'cylinder',
  curvature: 140,
  centre: 0,
  visibleLeft: 90,
  visibleRight: 90,
  tilt: 0,
};

/** Curvature below this (degrees) is treated as a flat surface (the limit of the mapping). */
const FLAT_EPSILON = 0.05;

export interface CylinderSpan {
  /** `true`: no wrapping at all, local x equals u. */
  flat: boolean;
  /** Artwork fraction range that is visible (0..1). */
  uMin: number;
  uMax: number;
  /** Angles (degrees) at the visible ends. */
  phiStart: number;
  phiEnd: number;
  /** `sin(phiEnd) - sin(phiStart)`: the horizontal extent of the visible part, per unit radius. */
  extent: number;
}

/**
 * The visible part of the artwork on the cylinder, or `null` when none of it faces the camera.
 *
 * The artwork's angle at fraction `u` is `phi(u) = centre + (u - 0.5) * curvature`. A point is
 * visible while `-visibleLeft <= phi <= visibleRight`. The placement rectangle bounds exactly that
 * visible part, so the merchant draws the box around what the shopper can see.
 */
export function cylinderSpan(s: CylinderSurface): CylinderSpan | null {
  if (s.curvature < FLAT_EPSILON) {
    return { flat: true, uMin: 0, uMax: 1, phiStart: 0, phiEnd: 0, extent: 1 };
  }
  const half = s.curvature / 2;
  const phiStart = Math.max(s.centre - half, -s.visibleLeft);
  const phiEnd = Math.min(s.centre + half, s.visibleRight);
  if (!(phiEnd - phiStart > 1e-6)) return null;
  const extent = Math.sin(phiEnd * DEG) - Math.sin(phiStart * DEG);
  if (!(extent > 1e-9)) return null;
  return {
    flat: false,
    uMin: 0.5 + (phiStart - s.centre) / s.curvature,
    uMax: 0.5 + (phiEnd - s.centre) / s.curvature,
    phiStart,
    phiEnd,
    extent,
  };
}

/**
 * Frame-local position of artwork point `(u, v)` on the cylinder, or `null` if it is hidden.
 * `aspect` is the frame's pixel width divided by its pixel height (it scales the vertical bow).
 *
 * Orthographic projection of a vertical cylinder: a point at angle `phi` is at horizontal position
 * `R sin(phi)`; the box maps the visible `sin` range onto `0..1`. With camera elevation `tilt` the
 * horizontal circle through a point sits `R sin(tilt) (cos(phi) - 1)` above the one facing the camera.
 */
export function cylinderLocal(
  s: CylinderSurface,
  u: number,
  v: number,
  aspect: number,
  span: CylinderSpan | null = cylinderSpan(s),
): Vec | null {
  if (!span) return null;
  if (span.flat) return [u, v];
  if (u < span.uMin - 1e-9 || u > span.uMax + 1e-9) return null;
  const phi = (s.centre + (u - 0.5) * s.curvature) * DEG;
  const x = (Math.sin(phi) - Math.sin(span.phiStart * DEG)) / span.extent;
  const radius = 1 / span.extent; // in frame widths
  const bow = radius * Math.sin(s.tilt * DEG) * (Math.cos(phi) - 1) * aspect;
  return [x, v + bow];
}

/**
 * Inverse of `cylinderLocal` along the horizontal axis: the artwork fraction `u` that lands at
 * frame-local `x`. Used by tests and by hit testing.
 */
export function cylinderInverseU(s: CylinderSurface, x: number): number | null {
  const span = cylinderSpan(s);
  if (!span) return null;
  if (span.flat) return x;
  const sine = Math.sin(span.phiStart * DEG) + x * span.extent;
  if (sine < -1 || sine > 1) return null;
  const phi = Math.asin(sine) / DEG;
  return 0.5 + (phi - s.centre) / s.curvature;
}

/** Clamp every parameter into its documented range (used by the editor controls). */
export function clampCylinder(s: CylinderSurface): CylinderSurface {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  return {
    type: 'cylinder',
    curvature: clamp(s.curvature, 0, SURFACE_LIMITS.maxCurvature),
    centre: clamp(s.centre, -SURFACE_LIMITS.maxCentre, SURFACE_LIMITS.maxCentre),
    visibleLeft: clamp(s.visibleLeft, SURFACE_LIMITS.minVisible, SURFACE_LIMITS.maxVisible),
    visibleRight: clamp(s.visibleRight, SURFACE_LIMITS.minVisible, SURFACE_LIMITS.maxVisible),
    tilt: clamp(s.tilt, -SURFACE_LIMITS.maxTilt, SURFACE_LIMITS.maxTilt),
  };
}

// ---- mesh ----------------------------------------------------------------------------------------

/** Uniform Catmull-Rom spline through p1 -> p2 (p0 and p3 are the neighbours), parameter t in 0..1. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function meshAt(mesh: MeshSpec, col: number, row: number, axis: 0 | 1): number {
  return mesh.points[(row * mesh.cols + col) * 2 + axis];
}

/** One-dimensional Catmull-Rom over `count` samples with linear extrapolation at both ends. */
function splineAlong(get: (i: number) => number, count: number, f: number): number {
  const cell = Math.min(count - 2, Math.max(0, Math.floor(f)));
  const t = f - cell;
  const p1 = get(cell);
  const p2 = get(cell + 1);
  const p0 = cell > 0 ? get(cell - 1) : 2 * p1 - p2;
  const p3 = cell + 2 < count ? get(cell + 2) : 2 * p2 - p1;
  return catmullRom(p0, p1, p2, p3, t);
}

/**
 * Frame-local position of artwork point `(u, v)` on the mesh. The surface passes exactly through
 * every control point (so dragging a point moves exactly that point of the artwork) and is
 * continuously differentiable across cells, which gives curved edges and smooth deformation.
 */
export function meshLocal(mesh: MeshSpec, u: number, v: number): Vec {
  const fu = Math.min(1, Math.max(0, u)) * (mesh.cols - 1);
  const fv = Math.min(1, Math.max(0, v)) * (mesh.rows - 1);
  const out: number[] = [0, 0];
  for (const axis of [0, 1] as const) {
    const column = (row: number) => splineAlong((c) => meshAt(mesh, c, row, axis), mesh.cols, fu);
    out[axis] = splineAlong(column, mesh.rows, fv);
  }
  return [out[0], out[1]];
}

export function clampMeshCells(n: number): number {
  return Math.min(MESH_LIMITS.maxCells, Math.max(MESH_LIMITS.minCells, Math.round(n)));
}

/** A mesh with `cols` x `rows` control points sampled from `surface` (flat when omitted). */
export function meshFromSurface(
  surface: CylinderSurface | undefined,
  aspect: number,
  cols: number,
  rows: number,
): MeshSpec {
  const c = clampMeshCells(cols);
  const r = clampMeshCells(rows);
  const span = surface ? cylinderSpan(surface) : null;
  const points: number[] = [];
  for (let j = 0; j < r; j++) {
    for (let i = 0; i < c; i++) {
      const u = i / (c - 1);
      const v = j / (r - 1);
      let p: Vec | null = [u, v];
      if (surface) {
        // Sample inside the visible range: a hidden artwork edge is pinned to the nearest visible one.
        const clampedU = span ? Math.min(span.uMax, Math.max(span.uMin, u)) : u;
        p = cylinderLocal(surface, clampedU, v, aspect, span) ?? [u, v];
      }
      points.push(round6(p[0]), round6(p[1]));
    }
  }
  return { cols: c, rows: r, points };
}

/** The same surface sampled on a different grid (changing the mesh density keeps its shape). */
export function resampleMesh(mesh: MeshSpec, cols: number, rows: number): MeshSpec {
  const c = clampMeshCells(cols);
  const r = clampMeshCells(rows);
  const points: number[] = [];
  for (let j = 0; j < r; j++) {
    for (let i = 0; i < c; i++) {
      const p = meshLocal(mesh, i / (c - 1), j / (r - 1));
      points.push(round6(p[0]), round6(p[1]));
    }
  }
  return { cols: c, rows: r, points };
}

export function moveMeshPoint(mesh: MeshSpec, index: number, to: Vec): MeshSpec {
  const points = mesh.points.slice();
  points[index * 2] = round6(to[0]);
  points[index * 2 + 1] = round6(to[1]);
  return { ...mesh, points };
}

/** Translate every control point by `(dx, dy)`. */
export function offsetMesh(mesh: MeshSpec, dx: number, dy: number): MeshSpec {
  return { ...mesh, points: mesh.points.map((n, i) => round6(n + (i % 2 === 0 ? dx : dy))) };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Smallest signed triangle area (frame units squared) a mesh triangle may have before it is degenerate. */
export const MIN_TRIANGLE_AREA = 1e-7;

export interface MeshFold {
  /** Control cell (column, row) containing the problem. */
  col: number;
  row: number;
}

/**
 * Cells whose surface is folded or collapsed. The surface is tessellated finely and every triangle
 * must keep the orientation of the unfolded artwork (clockwise on screen) with a non-trivial area; a
 * triangle that flips, or shrinks to nothing, marks its cell. `aspect` makes the areas isotropic.
 */
export function meshFolds(mesh: MeshSpec, aspect = 1, subdivisions = 4): MeshFold[] {
  const folds: MeshFold[] = [];
  const s = Math.max(1, subdivisions);
  const w = Math.sqrt(aspect);
  const h = 1 / w;
  for (let row = 0; row < mesh.rows - 1; row++) {
    for (let col = 0; col < mesh.cols - 1; col++) {
      let bad = false;
      const at = (a: number, b: number): Vec => {
        const p = meshLocal(mesh, (col + a / s) / (mesh.cols - 1), (row + b / s) / (mesh.rows - 1));
        return [p[0] * w, p[1] * h];
      };
      for (let b = 0; b < s && !bad; b++) {
        for (let a = 0; a < s && !bad; a++) {
          const p00 = at(a, b);
          const p10 = at(a + 1, b);
          const p11 = at(a + 1, b + 1);
          const p01 = at(a, b + 1);
          if (
            triangleArea(p00, p10, p11) < MIN_TRIANGLE_AREA ||
            triangleArea(p00, p11, p01) < MIN_TRIANGLE_AREA
          )
            bad = true;
        }
      }
      if (bad) folds.push({ col, row });
    }
  }
  return folds;
}

/** Signed area (positive when the triangle has the same orientation as the unfolded artwork). */
function triangleArea(a: Vec, b: Vec, c: Vec): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

// ---- placement frame ------------------------------------------------------------------------------

/**
 * Maps frame-local coordinates to mockup pixels for a placement: a rotated rectangle, or the
 * four-corner perspective quad. `canvasAspect` (artwork width / height) is only used when the frame
 * has no pixel aspect of its own, i.e. for a perspective quad.
 */
export interface Frame {
  /** Frame pixel width / height (for the cylinder's vertical bow). */
  aspect: number;
  toPixels(x: number, y: number): [number, number];
  /** Inverse of `toPixels` (used to turn a pointer position into frame-local coordinates). */
  fromPixels(x: number, y: number): [number, number] | null;
}

export function placementFrame(
  placement: AreaPlacement,
  mockupWidth: number,
  mockupHeight: number,
  canvasAspect: number,
): Frame | null {
  if (placement.type === 'quad' && placement.corners) {
    const px = placement.corners.map(
      ([x, y]) => [x * mockupWidth, y * mockupHeight] as Point,
    ) as unknown as [Point, Point, Point, Point];
    const m = squareToQuad(px);
    if (!m) return null;
    return {
      aspect: canvasAspect,
      toPixels: (x, y) => projectSquare(m, x, y),
      fromPixels: (x, y) => unprojectSquare(m, x, y),
    };
  }
  const w = placement.width * mockupWidth;
  const h = placement.height * mockupHeight;
  if (!(w > 0 && h > 0)) return null;
  const cx = (placement.x + placement.width / 2) * mockupWidth;
  const cy = (placement.y + placement.height / 2) * mockupHeight;
  const angle = (placement.rotation ?? 0) * DEG;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    aspect: w / h,
    toPixels: (x, y) => {
      const dx = (x - 0.5) * w;
      const dy = (y - 0.5) * h;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    },
    fromPixels: (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      return [(dx * cos + dy * sin) / w + 0.5, (-dx * sin + dy * cos) / h + 0.5];
    },
  };
}

// ---- warp grid --------------------------------------------------------------------------------------

/**
 * A structured grid of vertices for the rasterizer. Vertex `(i, j)` sits at `x[j * cols + i]`,
 * `y[...]` (mockup pixels) and samples the flat artwork at `(u, v)` (fractions). Each cell is split
 * into two triangles.
 */
export interface WarpGrid {
  cols: number;
  rows: number;
  x: Float64Array;
  y: Float64Array;
  u: Float64Array;
  v: Float64Array;
}

export interface WarpOptions {
  /** Output pixels per mockup pixel; decides how finely the surface is tessellated. */
  detail?: number;
}

/**
 * The warp grid of a placement that has a surface or mesh. Returns `null` when nothing is visible
 * (a cylinder whose visible range excludes the artwork) or the frame is unusable.
 */
export function buildWarpGrid(
  placement: AreaPlacement,
  mockupWidth: number,
  mockupHeight: number,
  canvasAspect: number,
  options: WarpOptions = {},
): WarpGrid | null {
  const frame = placementFrame(placement, mockupWidth, mockupHeight, canvasAspect);
  if (!frame) return null;
  const detail = options.detail ?? 1;

  let uMin = 0;
  let uMax = 1;
  let cols: number;
  let rows: number;
  let local: (u: number, v: number) => Vec | null;

  if (placement.mesh) {
    const mesh = placement.mesh;
    const approxPx =
      Math.max(placement.width * mockupWidth, placement.height * mockupHeight) * detail;
    const perCell = Math.min(16, Math.max(3, Math.ceil(approxPx / (mesh.cols - 1) / 14)));
    cols = (mesh.cols - 1) * perCell + 1;
    rows = (mesh.rows - 1) * perCell + 1;
    local = (u, v) => meshLocal(mesh, u, v);
  } else if (placement.surface) {
    const surface = placement.surface;
    const span = cylinderSpan(surface);
    if (!span) return null;
    uMin = span.uMin;
    uMax = span.uMax;
    const widthPx = placement.width * mockupWidth * detail;
    // One strip is a parallelogram (the bow depends on x only), so only the horizontal count matters;
    // a strip a couple of pixels wide keeps the chord error of the sine far below a pixel.
    cols = Math.min(513, Math.max(span.flat ? 2 : 33, Math.ceil(widthPx / 2) + 1));
    // A perspective quad bends the vertical lines' spacing, so it needs rows of its own.
    rows = placement.type === 'quad' ? 9 : 2;
    const aspect = frame.aspect;
    local = (u, v) => cylinderLocal(surface, u, v, aspect, span);
  } else {
    return null;
  }

  const n = cols * rows;
  const grid: WarpGrid = {
    cols,
    rows,
    x: new Float64Array(n),
    y: new Float64Array(n),
    u: new Float64Array(n),
    v: new Float64Array(n),
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = uMin + ((uMax - uMin) * i) / (cols - 1);
      const v = j / (rows - 1);
      const p = local(Math.min(uMax, Math.max(uMin, u)), v);
      if (!p) return null;
      const [px, py] = frame.toPixels(p[0], p[1]);
      const k = j * cols + i;
      grid.x[k] = px;
      grid.y[k] = py;
      grid.u[k] = u;
      grid.v[k] = v;
    }
  }
  return grid;
}

/** Axis-aligned bounds of the grid in mockup pixels. */
export function gridBounds(grid: WarpGrid): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < grid.x.length; k++) {
    if (grid.x[k] < minX) minX = grid.x[k];
    if (grid.x[k] > maxX) maxX = grid.x[k];
    if (grid.y[k] < minY) minY = grid.y[k];
    if (grid.y[k] > maxY) maxY = grid.y[k];
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
