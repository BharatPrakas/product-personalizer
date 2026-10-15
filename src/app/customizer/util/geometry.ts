/**
 * Shape and box geometry shared by the renderer and the merchant editor. Pure helpers plus
 * `Path2D` construction (browser only; nothing here touches the DOM beyond `Path2D` / `DOMMatrix`).
 */

import type { ShapeSpec } from '../models/product.models';
import { PRODUCT_LIMITS } from '../models/product.models';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEG = Math.PI / 180;

export function boxCenter(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Path data may only contain path commands, numbers and separators. */
const PATH_CHARS = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/;

export function isSafePathData(d: unknown): d is string {
  return (
    typeof d === 'string' &&
    d.length > 0 &&
    d.length <= PRODUCT_LIMITS.maxPathLength &&
    PATH_CHARS.test(d) &&
    /^\s*[Mm]/.test(d)
  );
}

/** A heart, authored in a 100 x 100 box. Used by the demo products. */
export const HEART_SHAPE: Extract<ShapeSpec, { type: 'path' }> = {
  type: 'path',
  viewBox: [100, 100],
  d: 'M50 92 C 20 68 2 50 2 30 C 2 14 14 4 28 4 C 38 4 46 9 50 18 C 54 9 62 4 72 4 C 86 4 98 14 98 30 C 98 50 80 68 50 92 Z',
};

export const RECT_SHAPE: ShapeSpec = { type: 'rect' };
export const ELLIPSE_SHAPE: ShapeSpec = { type: 'ellipse' };

/** A `Path2D` in canvas coordinates for `shape` fitted to `box`. */
export function shapePath(shape: ShapeSpec, box: Box): Path2D {
  const path = new Path2D();
  switch (shape.type) {
    case 'rect': {
      const radius = Math.max(
        0,
        Math.min(shape.cornerRadius ?? 0, 0.5) * Math.min(box.width, box.height),
      );
      if (radius > 0 && typeof path.roundRect === 'function') {
        path.roundRect(box.x, box.y, box.width, box.height, radius);
      } else {
        path.rect(box.x, box.y, box.width, box.height);
      }
      break;
    }
    case 'ellipse':
      path.ellipse(
        box.x + box.width / 2,
        box.y + box.height / 2,
        Math.max(box.width / 2, 0),
        Math.max(box.height / 2, 0),
        0,
        0,
        Math.PI * 2,
      );
      break;
    case 'path': {
      if (!isSafePathData(shape.d)) break;
      const [vw, vh] = shape.viewBox;
      if (!(vw > 0 && vh > 0)) break;
      path.addPath(
        new Path2D(shape.d),
        new DOMMatrix([box.width / vw, 0, 0, box.height / vh, box.x, box.y]),
      );
      break;
    }
  }
  return path;
}

/** Restrict later drawing to `shape` fitted to `box` (the caller owns the surrounding save/restore). */
export function clipToShape(ctx: CanvasRenderingContext2D, shape: ShapeSpec, box: Box): void {
  ctx.clip(shapePath(shape, box));
}

export function isPlainRect(shape: ShapeSpec | null | undefined): boolean {
  return !shape || (shape.type === 'rect' && !shape.cornerRadius);
}

/**
 * Pull the first usable outline out of an SVG document (used for uploaded masks): the `viewBox`
 * (or width/height) plus every `path`, `polygon`, `circle`, `ellipse` and `rect` merged into one
 * path. Returns null when nothing usable is found.
 */
export function parseSvgMask(svgText: string): Extract<ShapeSpec, { type: 'path' }> | null {
  if (typeof DOMParser === 'undefined' || svgText.length > 500_000) return null;
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.localName !== 'svg' || doc.querySelector('parsererror')) return null;

  let viewBox: [number, number] | null = null;
  const vb = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    if (vb[0] === 0 && vb[1] === 0) viewBox = [vb[2], vb[3]];
  }
  if (!viewBox) {
    const w = parseFloat(svg.getAttribute('width') ?? '');
    const h = parseFloat(svg.getAttribute('height') ?? '');
    if (w > 0 && h > 0) viewBox = [w, h];
  }
  if (!viewBox) return null;

  const num = (el: Element, name: string) => parseFloat(el.getAttribute(name) ?? '0') || 0;
  const parts: string[] = [];
  for (const el of Array.from(svg.querySelectorAll('path, polygon, circle, ellipse, rect'))) {
    switch (el.localName) {
      case 'path': {
        const d = el.getAttribute('d');
        if (isSafePathData(d)) parts.push(d);
        break;
      }
      case 'polygon': {
        const pts = (el.getAttribute('points') ?? '')
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        if (pts.length >= 6 && pts.length % 2 === 0 && pts.every(Number.isFinite)) {
          parts.push(
            pts.map((n, i) => (i === 0 ? `M${n}` : i % 2 === 0 ? `L${n}` : ` ${n}`)).join('') + 'Z',
          );
        }
        break;
      }
      case 'circle': {
        const [cx, cy, r] = [num(el, 'cx'), num(el, 'cy'), num(el, 'r')];
        if (r > 0)
          parts.push(`M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`);
        break;
      }
      case 'ellipse': {
        const [cx, cy, rx, ry] = [num(el, 'cx'), num(el, 'cy'), num(el, 'rx'), num(el, 'ry')];
        if (rx > 0 && ry > 0)
          parts.push(
            `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`,
          );
        break;
      }
      case 'rect': {
        const [x, y, w, h] = [num(el, 'x'), num(el, 'y'), num(el, 'width'), num(el, 'height')];
        if (w > 0 && h > 0) parts.push(`M${x} ${y}h${w}v${h}h${-w}Z`);
        break;
      }
    }
  }
  const d = parts.join(' ');
  return isSafePathData(d) ? { type: 'path', d, viewBox } : null;
}
