/**
 * Immutable editing operations for `BezierPath` (the Pen tool). Every function returns a new path
 * and never mutates its input, so the editor store can keep undo history by reference. Positions
 * are fractions of the mockup photograph, like the stored path.
 */

import type { BezierAnchor, BezierPath, Point } from '../../customizer/models/product.models';
import { BEZIER_LIMITS } from '../../customizer/models/product.models';
import { Pt, cubicAt, isStraight, segmentPoints } from '../../customizer/util/bezier';

export interface AnchorRef {
  contour: number;
  anchor: number;
}

export type HandleKind = 'in' | 'out';

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const pt = (x: number, y: number): Point => [round(x), round(y)];

function replaceAnchor(path: BezierPath, ref: AnchorRef, next: BezierAnchor): BezierPath {
  return {
    ...path,
    contours: path.contours.map((contour, ci) =>
      ci !== ref.contour
        ? contour
        : { anchors: contour.anchors.map((a, ai) => (ai === ref.anchor ? next : a)) },
    ),
  };
}

export function anchorAt(path: BezierPath, ref: AnchorRef): BezierAnchor | null {
  return path.contours[ref.contour]?.anchors[ref.anchor] ?? null;
}

export function totalAnchors(path: BezierPath): number {
  return path.contours.reduce((n, c) => n + c.anchors.length, 0);
}

// ---- construction --------------------------------------------------------------------------------------

/** A corner anchor at `(x, y)`. */
export function cornerAnchor(x: number, y: number): BezierAnchor {
  return { x: round(x), y: round(y) };
}

/**
 * The anchor made by pressing at `(x, y)` and dragging to `(dx, dy)`: the outgoing handle follows
 * the pointer and the incoming handle mirrors it, so the curve passes smoothly through the point.
 * A tiny drag stays a corner.
 */
export function dragAnchor(
  x: number,
  y: number,
  dx: number,
  dy: number,
  minDrag = 0,
): BezierAnchor {
  if (Math.hypot(dx - x, dy - y) <= minDrag) return cornerAnchor(x, y);
  return {
    x: round(x),
    y: round(y),
    handleIn: pt(2 * x - dx, 2 * y - dy),
    handleOut: pt(dx, dy),
    smooth: true,
  };
}

/** Whether another anchor can be added without exceeding the limits. */
export function canAddAnchor(path: BezierPath | null, contourAnchors = 0): boolean {
  return (
    contourAnchors < BEZIER_LIMITS.maxAnchorsPerContour &&
    (path ? totalAnchors(path) < BEZIER_LIMITS.maxAnchors : true)
  );
}

/** A closed path of one contour. */
export function pathFromAnchors(
  anchors: readonly BezierAnchor[],
  fillRule: BezierPath['fillRule'] = 'nonzero',
): BezierPath {
  return { version: 1, fillRule, contours: [{ anchors: anchors.map((a) => ({ ...a })) }] };
}

export function appendContour(path: BezierPath, anchors: readonly BezierAnchor[]): BezierPath {
  if (path.contours.length >= BEZIER_LIMITS.maxContours) return path;
  return { ...path, contours: [...path.contours, { anchors: anchors.map((a) => ({ ...a })) }] };
}

/** A new contour wound the opposite way to the first one, so under non-zero it cuts a hole. */
export function asHole(path: BezierPath, anchors: readonly BezierAnchor[]): BezierAnchor[] {
  const outer = path.contours[0];
  if (!outer) return [...anchors];
  const reverse = signedArea(anchors) * signedArea(outer.anchors) > 0;
  return reverse ? reverseAnchors(anchors) : [...anchors];
}

function signedArea(anchors: readonly BezierAnchor[]): number {
  let sum = 0;
  for (let i = 0, j = anchors.length - 1; i < anchors.length; j = i++) {
    sum += anchors[j].x * anchors[i].y - anchors[i].x * anchors[j].y;
  }
  return sum / 2;
}

/** The same outline traversed backwards: anchors reversed and each anchor's handles swapped. */
export function reverseAnchors(anchors: readonly BezierAnchor[]): BezierAnchor[] {
  return anchors
    .map((a) => {
      const r: BezierAnchor = { x: a.x, y: a.y };
      if (a.handleOut) r.handleIn = a.handleOut;
      if (a.handleIn) r.handleOut = a.handleIn;
      if (a.smooth) r.smooth = true;
      return r;
    })
    .reverse();
}

// ---- editing --------------------------------------------------------------------------------------------

/** Move an anchor; its handles travel with it. */
export function moveAnchor(path: BezierPath, ref: AnchorRef, x: number, y: number): BezierPath {
  const a = anchorAt(path, ref);
  if (!a) return path;
  const dx = x - a.x;
  const dy = y - a.y;
  const next: BezierAnchor = { ...a, x: round(x), y: round(y) };
  if (a.handleIn) next.handleIn = pt(a.handleIn[0] + dx, a.handleIn[1] + dy);
  if (a.handleOut) next.handleOut = pt(a.handleOut[0] + dx, a.handleOut[1] + dy);
  return replaceAnchor(path, ref, next);
}

/**
 * Move one control handle. Handles are independent on a corner anchor. On a smooth anchor the
 * opposite handle is kept collinear (it turns with the dragged one but keeps its own length), so
 * the curve stays smooth without forcing both handles to the same length.
 */
export function moveHandle(
  path: BezierPath,
  ref: AnchorRef,
  which: HandleKind,
  x: number,
  y: number,
  independent = false,
): BezierPath {
  const a = anchorAt(path, ref);
  if (!a) return path;
  const next: BezierAnchor = { ...a };
  const moved = pt(x, y);
  if (which === 'in') next.handleIn = moved;
  else next.handleOut = moved;
  const other = which === 'in' ? a.handleOut : a.handleIn;
  if (a.smooth && other && !independent) {
    const len = Math.hypot(other[0] - a.x, other[1] - a.y);
    const vx = a.x - x;
    const vy = a.y - y;
    const vl = Math.hypot(vx, vy);
    if (vl > 1e-9) {
      const mirrored = pt(a.x + (vx / vl) * len, a.y + (vy / vl) * len);
      if (which === 'in') next.handleOut = mirrored;
      else next.handleIn = mirrored;
    }
  }
  if (independent && a.smooth) delete next.smooth;
  return replaceAnchor(path, ref, next);
}

/**
 * Turn a corner into a smooth anchor (handles along the line between its neighbours, a third of the
 * way to each) or a smooth anchor into a corner (handles removed).
 */
export function toggleSmooth(path: BezierPath, ref: AnchorRef): BezierPath {
  const contour = path.contours[ref.contour];
  const a = anchorAt(path, ref);
  if (!contour || !a) return path;
  if (a.smooth || a.handleIn || a.handleOut) {
    return replaceAnchor(path, ref, { x: a.x, y: a.y });
  }
  const n = contour.anchors.length;
  const prev = contour.anchors[(ref.anchor + n - 1) % n];
  const next = contour.anchors[(ref.anchor + 1) % n];
  const tx = next.x - prev.x;
  const ty = next.y - prev.y;
  const tl = Math.hypot(tx, ty);
  if (tl < 1e-9) return path;
  const lengthIn = Math.hypot(a.x - prev.x, a.y - prev.y) / 3;
  const lengthOut = Math.hypot(next.x - a.x, next.y - a.y) / 3;
  return replaceAnchor(path, ref, {
    x: a.x,
    y: a.y,
    handleIn: pt(a.x - (tx / tl) * lengthIn, a.y - (ty / tl) * lengthIn),
    handleOut: pt(a.x + (tx / tl) * lengthOut, a.y + (ty / tl) * lengthOut),
    smooth: true,
  });
}

/**
 * Insert an anchor on the segment that starts at `segment` (de Casteljau split at `t`), keeping the
 * curve's shape exactly.
 */
export function insertAnchor(
  path: BezierPath,
  contour: number,
  segment: number,
  t: number,
): BezierPath {
  const c = path.contours[contour];
  if (!c || totalAnchors(path) >= BEZIER_LIMITS.maxAnchors) return path;
  if (c.anchors.length >= BEZIER_LIMITS.maxAnchorsPerContour) return path;
  const n = c.anchors.length;
  const a = c.anchors[segment];
  const b = c.anchors[(segment + 1) % n];
  const [p0, p1, p2, p3] = segmentPoints(a, b);
  const lerp = (p: Pt, q: Pt, k: number): Pt => [
    p[0] + (q[0] - p[0]) * k,
    p[1] + (q[1] - p[1]) * k,
  ];
  const straight = isStraight(a, b);
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const mid = straight ? lerp(p0, p3, t) : cubicAt([p0, p1, p2, p3], t);
  const anchors = c.anchors.slice();
  if (straight) {
    anchors.splice(segment + 1, 0, cornerAnchor(mid[0], mid[1]));
  } else {
    anchors[segment] = { ...a, handleOut: pt(p01[0], p01[1]) };
    const inserted: BezierAnchor = {
      x: round(mid[0]),
      y: round(mid[1]),
      handleIn: pt(p012[0], p012[1]),
      handleOut: pt(p123[0], p123[1]),
      smooth: true,
    };
    const after = { ...b, handleIn: pt(p23[0], p23[1]) };
    if (segment + 1 === n) {
      anchors[0] = after; // the segment closed the contour: its end is the first anchor
      anchors.push(inserted);
    } else {
      anchors[segment + 1] = after;
      anchors.splice(segment + 1, 0, inserted);
    }
  }
  return { ...path, contours: path.contours.map((x, i) => (i === contour ? { anchors } : x)) };
}

/**
 * Remove an anchor. A contour needs three anchors: removing one from a triangle removes the whole
 * contour, and removing the last contour returns `null` (no boundary left).
 */
export function removeAnchor(path: BezierPath, ref: AnchorRef): BezierPath | null {
  const contour = path.contours[ref.contour];
  if (!contour || !contour.anchors[ref.anchor]) return path;
  if (contour.anchors.length <= BEZIER_LIMITS.minAnchorsPerContour)
    return removeContour(path, ref.contour);
  const anchors = contour.anchors.filter((_, i) => i !== ref.anchor);
  return { ...path, contours: path.contours.map((c, i) => (i === ref.contour ? { anchors } : c)) };
}

export function removeContour(path: BezierPath, contour: number): BezierPath | null {
  const contours = path.contours.filter((_, i) => i !== contour);
  return contours.length > 0 ? { ...path, contours } : null;
}

export function translatePath(path: BezierPath, dx: number, dy: number): BezierPath {
  const move = (p: Point): Point => pt(p[0] + dx, p[1] + dy);
  return {
    ...path,
    contours: path.contours.map((c) => ({
      anchors: c.anchors.map((a) => ({
        ...a,
        x: round(a.x + dx),
        y: round(a.y + dy),
        ...(a.handleIn ? { handleIn: move(a.handleIn) } : {}),
        ...(a.handleOut ? { handleOut: move(a.handleOut) } : {}),
      })),
    })),
  };
}

export function setFillRule(path: BezierPath, fillRule: BezierPath['fillRule']): BezierPath {
  return path.fillRule === fillRule ? path : { ...path, fillRule };
}

// ---- hit testing -------------------------------------------------------------------------------------------

export interface SegmentHit {
  contour: number;
  segment: number;
  t: number;
  distance: number;
  point: Pt;
}

/**
 * The point of the path nearest to `p`, searching each segment's sampled curve. `maxDistance` and
 * the result are in photo fractions.
 */
export function nearestOnPath(path: BezierPath, p: Pt, maxDistance: number): SegmentHit | null {
  let best: SegmentHit | null = null;
  path.contours.forEach((contour, ci) => {
    const n = contour.anchors.length;
    for (let si = 0; si < n; si++) {
      const a = contour.anchors[si];
      const b = contour.anchors[(si + 1) % n];
      const cp = segmentPoints(a, b);
      const steps = isStraight(a, b) ? 1 : 48;
      let prev: Pt = cp[0];
      for (let k = 1; k <= steps; k++) {
        const tk = k / steps;
        const next = isStraight(a, b) ? cp[3] : cubicAt(cp, tk);
        const vx = next[0] - prev[0];
        const vy = next[1] - prev[1];
        const len2 = vx * vx + vy * vy;
        const u =
          len2 > 0
            ? Math.max(0, Math.min(1, ((p[0] - prev[0]) * vx + (p[1] - prev[1]) * vy) / len2))
            : 0;
        const qx = prev[0] + vx * u;
        const qy = prev[1] + vy * u;
        const d = Math.hypot(p[0] - qx, p[1] - qy);
        if (d <= maxDistance && (!best || d < best.distance)) {
          best = {
            contour: ci,
            segment: si,
            t: (k - 1 + u) / steps,
            distance: d,
            point: [qx, qy],
          };
        }
        prev = next;
      }
    }
  });
  return best;
}

/** The same path with every coordinate scaled by `(sx, sy)` (photo fractions -> pixels, for hit testing). */
export function scalePath(path: BezierPath, sx: number, sy: number): BezierPath {
  const scale = (p: Point): Point => [p[0] * sx, p[1] * sy];
  return {
    ...path,
    contours: path.contours.map((c) => ({
      anchors: c.anchors.map((a) => ({
        ...a,
        x: a.x * sx,
        y: a.y * sy,
        ...(a.handleIn ? { handleIn: scale(a.handleIn) } : {}),
        ...(a.handleOut ? { handleOut: scale(a.handleOut) } : {}),
      })),
    })),
  };
}

/** SVG path data for the path with each point mapped by `map` (used to draw the outline on screen). */
export function svgData(path: BezierPath, map: (x: number, y: number) => [number, number]): string {
  const parts: string[] = [];
  const f = (n: number) => n.toFixed(2);
  for (const contour of path.contours) {
    const n = contour.anchors.length;
    if (n === 0) continue;
    const start = map(contour.anchors[0].x, contour.anchors[0].y);
    parts.push(`M${f(start[0])} ${f(start[1])}`);
    for (let i = 0; i < n; i++) {
      const a = contour.anchors[i];
      const b = contour.anchors[(i + 1) % n];
      const e = map(b.x, b.y);
      if (isStraight(a, b)) {
        if (i < n - 1) parts.push(`L${f(e[0])} ${f(e[1])}`);
      } else {
        const c1 = map(...segmentPoints(a, b)[1]);
        const c2 = map(...segmentPoints(a, b)[2]);
        parts.push(`C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(e[0])} ${f(e[1])}`);
      }
    }
    parts.push('Z');
  }
  return parts.join('');
}
