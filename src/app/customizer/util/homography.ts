import type { Point } from '../models/product.models';

/** Projective map of the unit square onto `quad` (Heckbert), as 8 coefficients; null if degenerate. */
export function squareToQuad(q: readonly [Point, Point, Point, Point]): number[] | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) return null;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/** Apply a `squareToQuad` map to a point of the unit square. */
export function projectSquare(m: readonly number[], u: number, v: number): [number, number] {
  const w = m[6] * u + m[7] * v + 1;
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}

/**
 * Inverse of `projectSquare`: the unit-square point `(u, v)` that a `squareToQuad` map sends to
 * `(x, y)`. Returns null when the map is singular.
 */
export function unprojectSquare(
  m: readonly number[],
  x: number,
  y: number,
): [number, number] | null {
  // Matrix [[a, b, c], [d, e, f], [g, h, 1]]; inverse by its adjugate (the scale cancels in the divide).
  const [a, b, c, d, e, f, g, h] = m;
  const A = e - f * h;
  const B = c * h - b;
  const C = b * f - c * e;
  const D = f * g - d;
  const E = a - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const w = G * x + H * y + I;
  if (Math.abs(w) < 1e-12) return null;
  return [(A * x + B * y + C) / w, (D * x + E * y + F) / w];
}
