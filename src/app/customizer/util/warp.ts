/**
 * Exact software triangle rasterizer for surface warps.
 *
 * Why not draw each triangle with `ctx.drawImage` + `ctx.clip` like the perspective renderer does:
 * clip edges are anti-aliased, so neighbouring triangles either leave faint seams (no overlap) or
 * blend twice where they overlap (grown triangles): on a 50 % transparent source the second
 * approach measured alpha 252 instead of 128 on about 40 % of the interior in Chrome. Here every
 * output sample is covered by exactly one triangle (shared edges are evaluated bit-identically and
 * ties follow the top-left rule), so there are no seams, no gaps and no double blending, and
 * partially transparent artwork stays exactly as transparent as it was. It also needs no canvas, so
 * the pixel results are unit-tested without a browser.
 *
 * Sampling is bilinear and alpha-weighted (colour is interpolated premultiplied). Optional
 * supersampling (a box filter over `n x n` sub-samples) anti-aliases the silhouette and averages
 * where the surface compresses the artwork.
 */

import type { WarpGrid } from './surface';

/** RGBA, 8 bits per channel, NOT premultiplied (the layout of `ImageData`). */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface RasterRequest {
  grid: WarpGrid;
  source: PixelImage;
  /** Output pixels per grid unit (the grid is in mockup pixels). */
  scale: number;
  /** Output position of grid point `(0, 0)`: output x = `grid.x * scale - originX`. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Sub-samples per output pixel along each axis (1 = none). */
  supersample?: 1 | 2 | 3 | 4;
}

interface Edge {
  a: number;
  b: number;
  c: number;
  /** Whether a sample exactly on the edge belongs to this triangle (top-left rule). */
  tie: boolean;
}

/**
 * Edge function `a*x + b*y + c` that is >= 0 on the inside. The coefficients come from the
 * lexicographically ordered end points and are negated for the reversed direction, so two triangles
 * sharing an edge evaluate exactly opposite values at every sample (IEEE negation is exact).
 */
function edge(px: number, py: number, qx: number, qy: number, flip: boolean, out: Edge): void {
  const swapped = px > qx || (px === qx && py > qy);
  const lx = swapped ? qx : px;
  const ly = swapped ? qy : py;
  const hx = swapped ? px : qx;
  const hy = swapped ? py : qy;
  let a = -(hy - ly);
  let b = hx - lx;
  let c = -(a * lx + b * ly);
  if (swapped !== flip) {
    a = -a;
    b = -b;
    c = -c;
  }
  out.a = a;
  out.b = b;
  out.c = c;
  out.tie = a > 0 || (a === 0 && b > 0);
}

/** Render the warp grid into a new image. Pixels no triangle covers stay fully transparent. */
export function rasterizeWarp(req: RasterRequest): PixelImage {
  const ss = req.supersample ?? 1;
  const { grid, source } = req;
  const outW = Math.max(1, Math.round(req.width));
  const outH = Math.max(1, Math.round(req.height));
  const W = outW * ss;
  const H = outH * ss;
  // Premultiplied accumulation buffer at the supersampled resolution.
  const buffer = new Uint8ClampedArray(W * H * 4);
  const sw = source.width;
  const sh = source.height;
  const src = source.data;
  const k = req.scale * ss;
  const ox = req.originX * ss;
  const oy = req.originY * ss;

  const e0: Edge = { a: 0, b: 0, c: 0, tie: false };
  const e1: Edge = { a: 0, b: 0, c: 0, tie: false };
  const e2: Edge = { a: 0, b: 0, c: 0, tie: false };

  const triangle = (i0: number, i1: number, i2: number): void => {
    const x0 = grid.x[i0] * k - ox;
    const y0 = grid.y[i0] * k - oy;
    const x1 = grid.x[i1] * k - ox;
    const y1 = grid.y[i1] * k - oy;
    const x2 = grid.x[i2] * k - ox;
    const y2 = grid.y[i2] * k - oy;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-12)) return;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;
    const flip = area < 0;
    edge(x1, y1, x2, y2, flip, e0); // opposite vertex 0
    edge(x2, y2, x0, y0, flip, e1); // opposite vertex 1
    edge(x0, y0, x1, y1, flip, e2); // opposite vertex 2

    // Source position is affine in screen position over one triangle: u(x, y) = uc + du/dx * x + du/dy * y.
    const u0 = grid.u[i0] * sw;
    const v0 = grid.v[i0] * sh;
    const du1 = grid.u[i1] * sw - u0;
    const du2 = grid.u[i2] * sw - u0;
    const dv1 = grid.v[i1] * sh - v0;
    const dv2 = grid.v[i2] * sh - v0;
    const ex1 = x1 - x0;
    const ey1 = y1 - y0;
    const ex2 = x2 - x0;
    const ey2 = y2 - y0;
    const dudx = (du1 * ey2 - du2 * ey1) / area;
    const dudy = (du2 * ex1 - du1 * ex2) / area;
    const dvdx = (dv1 * ey2 - dv2 * ey1) / area;
    const dvdy = (dv2 * ex1 - dv1 * ex2) / area;
    const uBase = u0 - 0.5 - dudx * x0 - dudy * y0; // the -0.5 puts texel centres at integer positions
    const vBase = v0 - 0.5 - dvdx * x0 - dvdy * y0;
    const ea = e0.a;
    const eb = e0.b;
    const ec = e0.c;
    const et = e0.tie;
    const fa = e1.a;
    const fb = e1.b;
    const fc = e1.c;
    const ft = e1.tie;
    const ga = e2.a;
    const gb = e2.b;
    const gc = e2.c;
    const gt = e2.tie;
    const maxU = sw - 1;
    const maxV = sh - 1;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ea * px + eb * py + ec;
        if (w0 < 0 || (w0 === 0 && !et)) continue;
        const w1 = fa * px + fb * py + fc;
        if (w1 < 0 || (w1 === 0 && !ft)) continue;
        const w2 = ga * px + gb * py + gc;
        if (w2 < 0 || (w2 === 0 && !gt)) continue;
        // Source position, clamped to the image.
        let su = uBase + dudx * px + dudy * py;
        let sv = vBase + dvdx * px + dvdy * py;
        if (su < 0) su = 0;
        else if (su > maxU) su = maxU;
        if (sv < 0) sv = 0;
        else if (sv > maxV) sv = maxV;
        const ix = su | 0;
        const iy = sv | 0;
        const fx = su - ix;
        const fy = sv - iy;
        const ix1 = ix + 1 < sw ? ix + 1 : ix;
        const iy1 = iy + 1 < sh ? iy + 1 : iy;
        const p00 = (iy * sw + ix) * 4;
        const p10 = (iy * sw + ix1) * 4;
        const p01 = (iy1 * sw + ix) * 4;
        const p11 = (iy1 * sw + ix1) * 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const a00 = src[p00 + 3] * w00;
        const a10 = src[p10 + 3] * w10;
        const a01 = src[p01 + 3] * w01;
        const a11 = src[p11 + 3] * w11;
        const alpha = a00 + a10 + a01 + a11;
        const o = (y * W + x) * 4;
        if (alpha <= 0) {
          buffer[o] = buffer[o + 1] = buffer[o + 2] = buffer[o + 3] = 0;
          continue;
        }
        // Premultiplied colour: sum of weight * alpha * colour / 255.
        buffer[o] = (src[p00] * a00 + src[p10] * a10 + src[p01] * a01 + src[p11] * a11) / 255;
        buffer[o + 1] =
          (src[p00 + 1] * a00 + src[p10 + 1] * a10 + src[p01 + 1] * a01 + src[p11 + 1] * a11) / 255;
        buffer[o + 2] =
          (src[p00 + 2] * a00 + src[p10 + 2] * a10 + src[p01 + 2] * a01 + src[p11 + 2] * a11) / 255;
        buffer[o + 3] = alpha;
      }
    }
  };

  for (let j = 0; j < grid.rows - 1; j++) {
    for (let i = 0; i < grid.cols - 1; i++) {
      const a = j * grid.cols + i;
      const b = a + 1;
      const d = a + grid.cols;
      const c = d + 1;
      triangle(a, b, c);
      triangle(a, c, d);
    }
  }

  return resolve(buffer, W, outW, outH, ss);
}

/** Box-filter the premultiplied buffer down to `outW x outH` and un-premultiply. */
function resolve(
  buffer: Uint8ClampedArray,
  W: number,
  outW: number,
  outH: number,
  ss: number,
): PixelImage {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const n = ss * ss;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        let o = ((y * ss + sy) * W + x * ss) * 4;
        for (let sx = 0; sx < ss; sx++, o += 4) {
          r += buffer[o];
          g += buffer[o + 1];
          b += buffer[o + 2];
          a += buffer[o + 3];
        }
      }
      const o = (y * outW + x) * 4;
      if (a <= 0) continue;
      const alpha = a / n;
      // Premultiplied -> straight. The sums run over n samples, so the averages (r / n, a / n) give
      // colour = (r / n) * 255 / (a / n) = r * 255 / a.
      const scale = 255 / a;
      out[o] = r * scale;
      out[o + 1] = g * scale;
      out[o + 2] = b * scale;
      out[o + 3] = alpha;
    }
  }
  return { width: outW, height: outH, data: out };
}
