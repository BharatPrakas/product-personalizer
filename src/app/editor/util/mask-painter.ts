/**
 * The editable raster printable boundary (Brush Mask tool).
 *
 * Representation: an alpha mask on a canvas at (up to) the photo's native resolution. Painting adds
 * coverage, erasing removes it, soft brushes leave partial alpha, and that alpha channel is exactly
 * what the renderer multiplies the warped artwork by, so partially transparent pixels stay partial.
 * Brush sizes are in PHOTO pixels, so a stroke is the same size at any editor zoom.
 *
 * Why a raster mask and not stroke history or vectors: strokes would have to be replayed on every
 * load (cost grows with editing, soft brushes and erasing are order dependent, and the renderer would
 * need the brush engine); tracing to vectors loses the soft edge and any fine detail. A lossless
 * PNG of the alpha channel is small (flat regions compress to a few kilobytes), loads with the
 * ordinary image pipeline and is stored as an ordinary asset, never inside the D1 configuration JSON.
 */

import type { BezierPath } from '../../customizer/models/product.models';
import { bezierToPath2D } from '../../customizer/util/bezier';

/** Longest edge of the mask in pixels. A photo larger than this is painted at a reduced resolution. */
export const MAX_MASK_EDGE = 4096;

export type BrushMode = 'add' | 'erase';

export interface Brush {
  mode: BrushMode;
  /** Diameter in photo pixels. */
  size: number;
  /** 0 = fully soft edge, 1 = hard edge. */
  hardness: number;
}

export const BRUSH_LIMITS = { minSize: 1, maxSize: 600 } as const;

export interface MaskBounds {
  /** Fractions of the photo. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export class MaskPainter {
  readonly canvas: HTMLCanvasElement;
  /** Mask pixels per photo pixel. */
  readonly scale: number;
  private readonly ctx: CanvasRenderingContext2D;
  private lastX = 0;
  private lastY = 0;
  private carry = 0;
  private stroking = false;

  constructor(
    readonly photoWidth: number,
    readonly photoHeight: number,
  ) {
    this.scale = Math.min(1, MAX_MASK_EDGE / Math.max(photoWidth, photoHeight));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(photoWidth * this.scale));
    this.canvas.height = Math.max(1, Math.round(photoHeight * this.scale));
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  // ---- painting ----------------------------------------------------------------------------------

  /** Begin a stroke at photo pixel `(x, y)`. */
  begin(x: number, y: number, brush: Brush): void {
    this.stroking = true;
    this.lastX = x;
    this.lastY = y;
    this.carry = 0;
    this.stamp(x, y, brush);
  }

  /** Continue the stroke to photo pixel `(x, y)`, stamping at even spacing along the way. */
  extend(x: number, y: number, brush: Brush): void {
    if (!this.stroking) return this.begin(x, y, brush);
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const length = Math.hypot(dx, dy);
    if (length === 0) return;
    const spacing = Math.max(0.75, brush.size * 0.1);
    let travelled = spacing - this.carry;
    while (travelled <= length) {
      const k = travelled / length;
      this.stamp(this.lastX + dx * k, this.lastY + dy * k, brush);
      travelled += spacing;
    }
    this.carry = length - (travelled - spacing);
    this.lastX = x;
    this.lastY = y;
  }

  end(): void {
    this.stroking = false;
  }

  /** One round dab with a soft edge controlled by `hardness`. */
  stamp(x: number, y: number, brush: Brush): void {
    const ctx = this.ctx;
    const cx = x * this.scale;
    const cy = y * this.scale;
    const r = Math.max(0.5, (brush.size * this.scale) / 2);
    ctx.save();
    ctx.globalCompositeOperation = brush.mode === 'add' ? 'source-over' : 'destination-out';
    if (brush.hardness >= 0.999) {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const inner = Math.max(0, Math.min(1, brush.hardness)) * r;
      const gradient = ctx.createRadialGradient(cx, cy, inner, cx, cy, r);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Replace the mask with an existing mask image (stretched over the whole photo). */
  load(source: CanvasImageSource): void {
    this.clear();
    this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
  }

  /** Replace the mask with the area enclosed by a Bezier boundary, so it can be refined by painting. */
  loadPath(path: BezierPath): void {
    this.clear();
    this.ctx.fillStyle = '#000';
    this.ctx.fill(bezierToPath2D(path, this.canvas.width, this.canvas.height), path.fillRule);
  }

  // ---- measuring ---------------------------------------------------------------------------------

  /**
   * Bounds of everything painted, as fractions of the photo, found on a reduced copy (accurate to
   * about 1/256 of the photo). `null` when nothing is painted.
   */
  bounds(): MaskBounds | null {
    const side = 256;
    const w = Math.max(1, Math.round(side * Math.min(1, this.canvas.width / this.canvas.height)));
    const h = Math.max(1, Math.round(side * Math.min(1, this.canvas.height / this.canvas.width)));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    if (!sctx) return null;
    sctx.drawImage(this.canvas, 0, 0, w, h);
    const data = sctx.getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    small.width = small.height = 0;
    if (x1 < 0) return null;
    return { x: x0 / w, y: y0 / h, width: (x1 + 1 - x0) / w, height: (y1 + 1 - y0) / h };
  }

  isEmpty(): boolean {
    return this.bounds() === null;
  }

  /** Alpha (0..255) of the mask at photo pixel `(x, y)`. */
  alphaAt(x: number, y: number): number {
    const px = Math.min(this.canvas.width - 1, Math.max(0, Math.floor(x * this.scale)));
    const py = Math.min(this.canvas.height - 1, Math.max(0, Math.floor(y * this.scale)));
    return this.ctx.getImageData(px, py, 1, 1).data[3];
  }

  /** Lossless PNG of the mask (colour is black; the alpha channel is the coverage). */
  toBlob(): Promise<Blob> {
    return new Promise((resolve, reject) =>
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
        'image/png',
      ),
    );
  }

  dispose(): void {
    this.canvas.width = this.canvas.height = 0;
  }
}
