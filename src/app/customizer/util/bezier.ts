/**
 * Cubic Bezier geometry for printable boundaries (`PlacementMask` of type `path`). Everything here is
 * pure and works in the path's own space (fractions of the mockup photograph); `Path2D` is only built
 * on request. The storefront needs `bezierToPath2D` to clip the preview; editing helpers live in
 * the admin-only `editor/util/bezier-edit.ts`.
 */

import type { BezierAnchor, BezierContour, BezierPath } from '../models/product.models';

export type Pt = readonly [x: number, y: number];

/** The four cubic control points of the segment from `a` to `b`. */
export function segmentPoints(a: BezierAnchor, b: BezierAnchor): [Pt, Pt, Pt, Pt] {
  return [[a.x, a.y], a.handleOut ?? [a.x, a.y], b.handleIn ?? [b.x, b.y], [b.x, b.y]];
}

export function cubicAt(p: readonly [Pt, Pt, Pt, Pt], t: number): Pt {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const c = 3 * s * t * t;
  const d = t * t * t;
  return [
    a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0],
    a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1],
  ];
}

/** `true` when the segment from `a` to `b` is a straight line (no handle on either end). */
export function isStraight(a: BezierAnchor, b: BezierAnchor): boolean {
  return !a.handleOut && !b.handleIn;
}

/**
 * Polyline approximating one closed contour. `pixelsPerUnit` is how many output pixels one unit
 * (the whole photo width / height) spans, so the flattening error stays below `tolerance` pixels.
 * The polyline is NOT closed (the first point is not repeated).
 */
export function flattenContour(
  contour: BezierContour,
  pixelsPerUnit = 1000,
  tolerance = 0.25,
): Pt[] {
  const out: Pt[] = [];
  const n = contour.anchors.length;
  for (let i = 0; i < n; i++) {
    const a = contour.anchors[i];
    const b = contour.anchors[(i + 1) % n];
    out.push([a.x, a.y]);
    if (isStraight(a, b)) continue;
    const p = segmentPoints(a, b);
    // The control polygon bounds the curve length from above; error shrinks with the square of the steps.
    let length = 0;
    for (let k = 0; k < 3; k++) length += Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
    const steps = Math.min(
      256,
      Math.max(4, Math.ceil(Math.sqrt((length * pixelsPerUnit) / (8 * tolerance)) * 1.5)),
    );
    for (let s = 1; s < steps; s++) out.push(cubicAt(p, s / steps));
  }
  return out;
}

/** Signed area of a polygon (shoelace). Positive for clockwise on a y-down canvas. */
export function polygonArea(points: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return sum / 2;
}

/** Area enclosed by a contour, in squared photo fractions (always >= 0 for a simple contour). */
export function contourArea(contour: BezierContour): number {
  return Math.abs(polygonArea(flattenContour(contour)));
}

/** Narrowest a contour may be (in photo fractions) before it is called degenerate: about a tenth of a pixel. */
export const MIN_CONTOUR_THICKNESS = 1e-4;

/**
 * A contour that encloses (almost) nothing: its anchors coincide or lie on one line. Judged by the
 * contour's thickness (its largest distance from its own long axis), not by its signed area, because
 * a self-intersecting contour such as a bow-tie has two real lobes whose signed areas cancel out.
 */
export function isDegenerateContour(contour: BezierContour): boolean {
  const poly = flattenContour(contour);
  if (poly.length < 3) return true;
  const far = (from: Pt) => {
    let best = poly[0];
    let bestD = -1;
    for (const p of poly) {
      const d = Math.hypot(p[0] - from[0], p[1] - from[1]);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    return { point: best, distance: bestD };
  };
  const a = far(poly[0]).point;
  const { point: b, distance: length } = far(a);
  if (length < MIN_CONTOUR_THICKNESS) return true;
  let thickness = 0;
  for (const p of poly) {
    const d = Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) / length;
    if (d > thickness) thickness = d;
  }
  return thickness < MIN_CONTOUR_THICKNESS;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of the flattened path (handles that do not bend the curve outwards are ignored). */
export function bezierBounds(path: BezierPath): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of path.contours) {
    for (const [x, y] of flattenContour(contour)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return minX <= maxX ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/**
 * Winding number of `point` against one polygon (non-zero when inside under the non-zero rule).
 * Crossing-number counting with signed edges; points exactly on an edge are classified consistently
 * by the half-open interval rule.
 */
function windingNumber(point: Pt, polygon: readonly Pt[]): number {
  let winding = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (a[1] <= point[1]) {
      if (b[1] > point[1] && cross(a, b, point) > 0) winding++;
    } else if (b[1] <= point[1] && cross(a, b, point) < 0) {
      winding--;
    }
  }
  return winding;
}

function cross(a: Pt, b: Pt, p: Pt): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
}

/** Whether `point` is inside `path` according to its fill rule (all contours combined). */
export function pointInBezierPath(path: BezierPath, point: Pt): boolean {
  let winding = 0;
  let crossings = 0;
  for (const contour of path.contours) {
    const polygon = flattenContour(contour);
    const w = windingNumber(point, polygon);
    winding += w;
    if (w !== 0) crossings += Math.abs(w);
  }
  return path.fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
}

/**
 * Whether a contour crosses itself (two non-adjacent segments of the flattened curve intersect).
 * Only informational: the fill rule gives such a contour a well-defined inside.
 */
export function contourSelfIntersects(contour: BezierContour): boolean {
  const poly = flattenContour(contour, 400, 0.5);
  const n = poly.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // they share the closing vertex
      const b1 = poly[j];
      const b2 = poly[(j + 1) % n];
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function segmentsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** A `Path2D` for the path scaled to `width` x `height` pixels. */
export function bezierToPath2D(path: BezierPath, width: number, height: number): Path2D {
  const out = new Path2D();
  for (const contour of path.contours) {
    const n = contour.anchors.length;
    if (n === 0) continue;
    out.moveTo(contour.anchors[0].x * width, contour.anchors[0].y * height);
    for (let i = 0; i < n; i++) {
      const a = contour.anchors[i];
      const b = contour.anchors[(i + 1) % n];
      if (isStraight(a, b)) {
        if (i < n - 1) out.lineTo(b.x * width, b.y * height);
      } else {
        const [, c1, c2, end] = segmentPoints(a, b);
        out.bezierCurveTo(
          c1[0] * width,
          c1[1] * height,
          c2[0] * width,
          c2[1] * height,
          end[0] * width,
          end[1] * height,
        );
      }
    }
    out.closePath();
  }
  return out;
}

/**
 * SVG path data (`M … C … Z`) for the path, with its coordinates mapped from photo fractions into
 * `box` (so a path drawn on the photo can become a production shape fitted to its own bounds).
 */
export function bezierToSvgPath(path: BezierPath, box: Bounds, decimals = 3): string {
  const fmt = (n: number) => String(Number(n.toFixed(decimals)));
  const px = (x: number) => fmt((x - box.x) / box.width);
  const py = (y: number) => fmt((y - box.y) / box.height);
  const parts: string[] = [];
  for (const contour of path.contours) {
    const n = contour.anchors.length;
    if (n === 0) continue;
    parts.push(`M${px(contour.anchors[0].x)} ${py(contour.anchors[0].y)}`);
    for (let i = 0; i < n; i++) {
      const a = contour.anchors[i];
      const b = contour.anchors[(i + 1) % n];
      if (isStraight(a, b)) {
        if (i < n - 1) parts.push(`L${px(b.x)} ${py(b.y)}`);
      } else {
        const [, c1, c2, end] = segmentPoints(a, b);
        parts.push(
          `C${px(c1[0])} ${py(c1[1])} ${px(c2[0])} ${py(c2[1])} ${px(end[0])} ${py(end[1])}`,
        );
      }
    }
    parts.push('Z');
  }
  return parts.join('');
}

export function emptyBezierPath(): BezierPath {
  return { version: 1, fillRule: 'nonzero', contours: [] };
}
