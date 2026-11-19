/**
 * Canvas 2D drawing. One implementation serves every output: the on-screen preview, the merchant
 * editor, the production artwork of each printable area (scale 1, no previews-only content) and
 * the combined product preview.
 */

import type { AreaPlacement, BlendMode, MockupOverlay, Point } from '../models/product.models';
import { hasMockupGeometry } from '../models/product.models';
import { bezierBounds, bezierToPath2D } from './bezier';
import { DEG, boxCenter, clipToShape, shapePath } from './geometry';
import { projectSquare, squareToQuad } from './homography';
import { AreaScene, ImageOp, PlaceholderOp, SceneOp, ShapeOp, TextOp } from './scene';
import { buildWarpGrid, gridBounds } from './surface';
import { PixelImage, rasterizeWarp } from './warp';

export interface SceneTransform {
  x: number;
  y: number;
  scale: number;
}

export interface DrawSceneOptions {
  /** Include preview-only operations (empty-slot placeholders). Always false for production. */
  includePreviewOnly: boolean;
  /** Draw a checkerboard behind transparent areas (merchant editor). */
  checkerboard?: boolean;
}

export const PRODUCTION: DrawSceneOptions = { includePreviewOnly: false };

/**
 * Draws one printable area on its own canvas coordinate system. Everything is clipped to the
 * area's shape, so the exported artwork is transparent outside the mask.
 */
export function drawAreaScene(
  ctx: CanvasRenderingContext2D,
  scene: AreaScene,
  options: DrawSceneOptions,
  transform: SceneTransform = { x: 0, y: 0, scale: 1 },
): void {
  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);
  const full = { x: 0, y: 0, width: scene.width, height: scene.height };
  ctx.clip(shapePath(scene.shape, full));
  if (options.checkerboard) drawCheckerboard(ctx, scene.width, scene.height);
  if (scene.background !== 'transparent') {
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const op of scene.ops) {
    if (op.previewOnly && !options.includePreviewOnly) continue;
    drawOp(ctx, op);
  }
  ctx.restore();
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const cell = Math.max(16, Math.round(Math.min(width, height) / 48));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e5e7eb';
  for (let y = 0; y * cell < height; y++) {
    for (let x = (y % 2) * 1; x * cell < width; x += 2)
      ctx.fillRect(x * cell, y * cell, cell, cell);
  }
}

export function drawOp(ctx: CanvasRenderingContext2D, op: SceneOp): void {
  ctx.save();
  if (op.rotation) {
    const c = boxCenter(op.box);
    ctx.translate(c.x, c.y);
    ctx.rotate(op.rotation * DEG);
    ctx.translate(-c.x, -c.y);
  }
  if (op.opacity < 1) ctx.globalAlpha *= Math.max(0, op.opacity);
  if (op.clip) clipToShape(ctx, op.clip, op.box);
  switch (op.kind) {
    case 'image':
      drawImageOp(ctx, op);
      break;
    case 'text':
      drawTextOp(ctx, op);
      break;
    case 'shape':
      drawShapeOp(ctx, op);
      break;
    case 'placeholder':
      drawPlaceholderOp(ctx, op);
      break;
  }
  ctx.restore();
}

function drawImageOp(ctx: CanvasRenderingContext2D, op: ImageOp): void {
  drawImageRegion(ctx, op.source, op.turns, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh);
}

/**
 * Draw the `sx,sy,sw,sh` region of `source` (as seen after `turns` clockwise quarter turns) into
 * `dx,dy,dw,dh`. Used by the scene renderer and by the photo crop editor so both always agree.
 */
export function drawImageRegion(
  ctx: CanvasRenderingContext2D,
  source: ImageBitmap,
  turns: 0 | 1 | 2 | 3,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (turns === 0) {
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  // The source rectangle is expressed in the turned image: map that space onto the destination,
  // then draw the original image turned about the centre of the turned space.
  const turnedW = turns % 2 === 1 ? source.height : source.width;
  const turnedH = turns % 2 === 1 ? source.width : source.height;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  const kx = dw / sw;
  const ky = dh / sh;
  ctx.translate(dx - sx * kx, dy - sy * ky);
  ctx.scale(kx, ky);
  ctx.translate(turnedW / 2, turnedH / 2);
  ctx.rotate(turns * (Math.PI / 2));
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  ctx.restore();
}

function drawTextOp(ctx: CanvasRenderingContext2D, op: TextOp): void {
  ctx.font = op.font;
  ctx.fillStyle = op.color;
  ctx.textAlign = op.align;
  ctx.textBaseline = 'alphabetic';
  const thickness = Math.max(1, op.fontSize / 16);
  for (const line of op.lines) {
    ctx.fillText(line.text, line.x, line.y);
    if (op.underline) {
      const left =
        op.align === 'left'
          ? line.x
          : op.align === 'right'
            ? line.x - line.width
            : line.x - line.width / 2;
      ctx.fillRect(left, line.y + op.fontSize * 0.12, line.width, thickness);
    }
  }
}

function drawShapeOp(ctx: CanvasRenderingContext2D, op: ShapeOp): void {
  const path = shapePath(op.shape, op.box);
  if (op.fill !== 'transparent') {
    ctx.fillStyle = op.fill;
    ctx.fill(path);
  }
  if (op.stroke && op.strokeWidth > 0) {
    ctx.strokeStyle = op.stroke;
    ctx.lineWidth = op.strokeWidth;
    ctx.stroke(path);
  }
}

function drawPlaceholderOp(ctx: CanvasRenderingContext2D, op: PlaceholderOp): void {
  const { box } = op;
  const outline = op.clip
    ? shapePath(op.clip, box)
    : shapePath({ type: 'rect', cornerRadius: 0.04 }, box);
  ctx.fillStyle = 'rgba(100, 116, 139, 0.16)';
  ctx.fill(outline);
  const unit = Math.max(2, Math.min(box.width, box.height) / 60);
  ctx.setLineDash([unit * 3, unit * 2]);
  ctx.lineWidth = unit;
  ctx.strokeStyle = 'rgba(71, 85, 105, 0.75)';
  ctx.stroke(outline);
  ctx.setLineDash([]);

  const size = Math.max(
    10,
    Math.min(box.height * 0.2, box.width / Math.max(6, op.label.length * 0.6), 120),
  );
  ctx.fillStyle = 'rgba(51, 65, 85, 0.9)';
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const c = boxCenter(box);
  ctx.fillText(op.label, c.x, c.y, box.width * 0.9);
}

// ---- composition onto the mockup ------------------------------------------------------------

export interface PlacedArea {
  placement: AreaPlacement;
  /** The area rendered on its own canvas (any resolution, same aspect as the area). */
  source: CanvasImageSource & { width: number; height: number };
  /**
   * The decoded alpha mask when the placement has a raster printable boundary. A raster boundary
   * whose image is not available yet hides the area (the artwork is never shown unclipped).
   */
  maskBitmap?: ImageBitmap;
  /** Changes whenever `source`'s pixels change; lets a `WarpCache` reuse its work. */
  sourceVersion?: number;
}

/**
 * 'final': supersampled, for exports and resting views. 'draft': one sample per pixel, used while a
 * handle is being dragged so the preview keeps up with the pointer.
 */
export type WarpQuality = 'draft' | 'final';

export interface CompositeOptions {
  quality?: WarpQuality;
  /** Reuses warped layers between repaints (pan, zoom steps, unrelated edits). */
  cache?: WarpCache;
}

export interface CompositeOverlay {
  overlay: MockupOverlay;
  bitmap: ImageBitmap;
}

export interface CompositeInput {
  mockup: ImageBitmap;
  background?: string;
  areas: PlacedArea[];
  overlays: CompositeOverlay[];
  options?: CompositeOptions;
}

const BLEND: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  overlay: 'overlay',
  'soft-light': 'soft-light',
};

/** Pixel size the area's source canvas should have for good quality at `width` x `height` output. */
export function placementPixelSize(
  placement: AreaPlacement,
  width: number,
  height: number,
): { w: number; h: number } {
  if (placement.type === 'quad' && placement.corners) {
    const xs = placement.corners.map((p) => p[0] * width);
    const ys = placement.corners.map((p) => p[1] * height);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { w: placement.width * width, h: placement.height * height };
}

export function drawComposite(
  ctx: CanvasRenderingContext2D,
  input: CompositeInput,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (input.background) {
    ctx.fillStyle = input.background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(input.mockup, 0, 0, width, height);
  for (const placed of input.areas) drawPlaced(ctx, placed, width, height, input.options);
  for (const { overlay, bitmap } of input.overlays) {
    ctx.globalAlpha = overlay.opacity ?? 1;
    ctx.drawImage(
      bitmap,
      (overlay.x ?? 0) * width,
      (overlay.y ?? 0) * height,
      (overlay.width ?? 1) * width,
      (overlay.height ?? 1) * height,
    );
  }
  ctx.restore();
}

function drawPlaced(
  ctx: CanvasRenderingContext2D,
  placed: PlacedArea,
  width: number,
  height: number,
  options?: CompositeOptions,
): void {
  const { placement, source } = placed;
  ctx.save();
  ctx.globalAlpha = placement.opacity ?? 1;
  ctx.globalCompositeOperation = BLEND[placement.blendMode ?? 'normal'];
  if (hasMockupGeometry(placement)) {
    drawWarped(ctx, placed, width, height, options);
  } else if (placement.type === 'quad' && placement.corners) {
    drawQuad(ctx, source, placement.corners, width, height);
  } else {
    const w = placement.width * width;
    const h = placement.height * height;
    ctx.translate(
      (placement.x + placement.width / 2) * width,
      (placement.y + placement.height / 2) * height,
    );
    ctx.rotate((placement.rotation ?? 0) * DEG);
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

// ---- four-corner perspective -------------------------------------------------------------------

const QUAD_GRID = 14;

/**
 * Perspective mapping with a proper homography: the source is cut into a grid, every grid point is
 * projected, and each cell is drawn as two affinely mapped triangles. With a 14 x 14 grid the
 * residual error is far below a pixel for realistic mockup quads.
 */
function drawQuad(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource & { width: number; height: number },
  corners: readonly [Point, Point, Point, Point],
  width: number,
  height: number,
): void {
  const px = corners.map(([x, y]) => [x * width, y * height] as const) as unknown as [
    Point,
    Point,
    Point,
    Point,
  ];
  const m = squareToQuad(px);
  if (!m) return;
  const project = (u: number, v: number): [number, number] => projectSquare(m, u, v);
  const sw = source.width;
  const sh = source.height;
  for (let j = 0; j < QUAD_GRID; j++) {
    for (let i = 0; i < QUAD_GRID; i++) {
      const u0 = i / QUAD_GRID;
      const u1 = (i + 1) / QUAD_GRID;
      const v0 = j / QUAD_GRID;
      const v1 = (j + 1) / QUAD_GRID;
      const a = project(u0, v0);
      const b = project(u1, v0);
      const c = project(u1, v1);
      const d = project(u0, v1);
      drawTriangle(
        ctx,
        source,
        [u0 * sw, v0 * sh],
        [u1 * sw, v0 * sh],
        [u1 * sw, v1 * sh],
        a,
        b,
        c,
      );
      drawTriangle(
        ctx,
        source,
        [u0 * sw, v0 * sh],
        [u1 * sw, v1 * sh],
        [u0 * sw, v1 * sh],
        a,
        c,
        d,
      );
    }
  }
}

type P2 = readonly [number, number];

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  s0: P2,
  s1: P2,
  s2: P2,
  d0: P2,
  d1: P2,
  d2: P2,
): void {
  const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (Math.abs(det) < 1e-9) return;
  const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / det;
  const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / det;
  const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / det;
  const d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / det;
  const e = d0[0] - a * s0[0] - c * s0[1];
  const f = d0[1] - b * s0[0] - d * s0[1];

  // Grow the clip triangle by one pixel on every side (scaling about the incentre), so neighbouring
  // cells overlap and the anti-aliased clip edges leave no light seams between them.
  const [g0, g1, g2] = growTriangle(d0, d1, d2, 1);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g0[0], g0[1]);
  ctx.lineTo(g1[0], g1[1]);
  ctx.lineTo(g2[0], g2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

function growTriangle(a: P2, b: P2, c: P2, by: number): [P2, P2, P2] {
  const la = Math.hypot(b[0] - c[0], b[1] - c[1]);
  const lb = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const lc = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const perimeter = la + lb + lc;
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  if (perimeter < 1e-9 || area < 1e-9) return [a, b, c];
  const radius = (2 * area) / perimeter;
  const ix = (la * a[0] + lb * b[0] + lc * c[0]) / perimeter;
  const iy = (la * a[1] + lb * b[1] + lc * c[1]) / perimeter;
  const k = (radius + by) / radius;
  const scale = (p: P2): P2 => [ix + (p[0] - ix) * k, iy + (p[1] - iy) * k];
  return [scale(a), scale(b), scale(c)];
}

// ---- surfaces, meshes and printable boundaries ----------------------------------------------------------

/** Most pixels one warped layer may have; larger ones are rendered smaller and scaled up when drawn. */
const MAX_LAYER_PIXELS = 4_000_000;
/** While a handle is dragged the layer is kept this small, so the preview follows the pointer. */
const DRAFT_LAYER_PIXELS = 300_000;
/** Largest layer that is still supersampled in 'final' quality (the rasterizer does about 7 megapixels per second). */
const MAX_SUPERSAMPLED_PIXELS = 600_000;

interface WarpLayer {
  canvas: HTMLCanvasElement;
  /** Where the layer goes, in the units of the composite (`width` x `height`). */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WarpEntry {
  placement: AreaPlacement;
  maskBitmap: ImageBitmap | undefined;
  version: number | undefined;
  key: string;
  layer: WarpLayer;
}

/**
 * Warped layers (and the source pixels they were read from) per printable area. A layer is reused
 * while the placement, its mask, the artwork pixels and the target size are unchanged, so panning
 * and zooming the editor, or editing another area, never re-run the warp.
 */
export class WarpCache {
  private readonly entries = new Map<string, WarpEntry>();
  private readonly pixels = new Map<string, { version: number; image: PixelImage }>();

  /** Warps computed since creation (lets tests and the editor observe cache effectiveness). */
  builds = 0;

  layerFor(
    id: string,
    placed: PlacedArea,
    key: string,
    build: () => WarpLayer | null,
  ): WarpLayer | null {
    const { placement, maskBitmap, sourceVersion } = placed;
    const hit = this.entries.get(id);
    if (
      hit &&
      sourceVersion !== undefined &&
      hit.version === sourceVersion &&
      hit.placement === placement &&
      hit.maskBitmap === maskBitmap &&
      hit.key === key
    )
      return hit.layer;
    if (hit) hit.layer.canvas.width = hit.layer.canvas.height = 0;
    const layer = build();
    this.builds++;
    if (!layer) {
      this.entries.delete(id);
      return null;
    }
    this.entries.set(id, { placement, maskBitmap, version: sourceVersion, key, layer });
    return layer;
  }

  /** The area canvas's pixels, read back once per version. */
  pixelsFor(id: string, source: PlacedArea['source'], version: number | undefined): PixelImage {
    const hit = this.pixels.get(id);
    if (hit && version !== undefined && hit.version === version) return hit.image;
    const image = readPixels(source);
    if (version !== undefined) this.pixels.set(id, { version, image });
    return image;
  }

  retain(areaIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (areaIds.has(id)) continue;
      entry.layer.canvas.width = entry.layer.canvas.height = 0;
      this.entries.delete(id);
    }
    for (const id of this.pixels.keys()) if (!areaIds.has(id)) this.pixels.delete(id);
  }

  dispose(): void {
    this.retain(new Set());
  }
}

function readPixels(source: PlacedArea['source']): PixelImage {
  const width = Math.max(1, Math.round(source.width));
  const height = Math.max(1, Math.round(source.height));
  let canvas: HTMLCanvasElement;
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    canvas = source;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(source, 0, 0, width, height);
  }
  const data = canvas.getContext('2d')?.getImageData(0, 0, width, height);
  if (!data) return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  return { width, height, data: data.data };
}

/** Axis-aligned bounds, in composite units, of the part of the page the placement can touch. */
function placementBounds(
  placed: PlacedArea,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const { placement } = placed;
  const canvasAspect = placed.source.width / placed.source.height;
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  if (placement.surface || placement.mesh) {
    const grid = buildWarpGrid(placement, width, height, canvasAspect);
    bounds = grid ? gridBounds(grid) : null;
  } else if (placement.type === 'quad' && placement.corners) {
    const xs = placement.corners.map((p) => p[0] * width);
    const ys = placement.corners.map((p) => p[1] * height);
    bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  } else {
    const w = placement.width * width;
    const h = placement.height * height;
    const a = (placement.rotation ?? 0) * DEG;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    bounds = {
      x: (placement.x + placement.width / 2) * width - bw / 2,
      y: (placement.y + placement.height / 2) * height - bh / 2,
      width: bw,
      height: bh,
    };
  }
  if (!bounds) return null;
  // Artwork only shows inside a path boundary: render just that part.
  if (placement.mask?.type === 'path') {
    const m = bezierBounds(placement.mask.path);
    if (!m) return null;
    const x0 = Math.max(bounds.x, m.x * width);
    const y0 = Math.max(bounds.y, m.y * height);
    const x1 = Math.min(bounds.x + bounds.width, (m.x + m.width) * width);
    const y1 = Math.min(bounds.y + bounds.height, (m.y + m.height) * height);
    if (!(x1 > x0 && y1 > y0)) return null;
    bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  return bounds;
}

/**
 * Draw a placement that has a printable boundary and/or a surface. The artwork is first rendered
 * (warped) into its own transparent layer in photo space, THEN clipped to the boundary, THEN drawn
 * with the placement's opacity and blend mode: the boundary is a region of the photograph, so it
 * must clip the final warped picture, never the flat artwork.
 */
function drawWarped(
  ctx: CanvasRenderingContext2D,
  placed: PlacedArea,
  width: number,
  height: number,
  options?: CompositeOptions,
): void {
  const { placement } = placed;
  if (placement.mask?.type === 'raster' && !placed.maskBitmap) return;
  const t = ctx.getTransform();
  const density = Math.max(1e-3, Math.hypot(t.a, t.b));
  const quality = options?.quality ?? 'final';
  const cache = options?.cache;
  const id = placement.printableAreaId;
  const key = `${width}x${height}|${density.toFixed(3)}|${quality}`;
  const build = () => buildLayer(placed, width, height, density, quality, cache);
  const layer = cache ? cache.layerFor(id, placed, key, build) : build();
  if (!layer) return;
  ctx.drawImage(layer.canvas, layer.x, layer.y, layer.width, layer.height);
  if (!cache) layer.canvas.width = layer.canvas.height = 0;
}

function buildLayer(
  placed: PlacedArea,
  width: number,
  height: number,
  density: number,
  quality: WarpQuality,
  cache: WarpCache | undefined,
): WarpLayer | null {
  const { placement, source } = placed;
  const bounds = placementBounds(placed, width, height);
  if (!bounds || !(bounds.width > 0 && bounds.height > 0)) return null;

  // Layer resolution: `density` layer pixels per unit, reduced when the layer would be too large.
  let scale = density;
  const wanted = bounds.width * scale * (bounds.height * scale);
  const budget = quality === 'draft' ? DRAFT_LAYER_PIXELS : MAX_LAYER_PIXELS;
  if (wanted > budget) scale *= Math.sqrt(budget / wanted);
  const originX = Math.floor(bounds.x * scale) - 1;
  const originY = Math.floor(bounds.y * scale) - 1;
  const lw = Math.max(1, Math.ceil((bounds.x + bounds.width) * scale) - originX + 1);
  const lh = Math.max(1, Math.ceil((bounds.y + bounds.height) * scale) - originY + 1);

  const canvas = document.createElement('canvas');
  canvas.width = lw;
  canvas.height = lh;
  const lctx = canvas.getContext('2d');
  if (!lctx) return null;
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = 'high';

  if (placement.surface || placement.mesh) {
    const grid = buildWarpGrid(placement, width, height, source.width / source.height, {
      detail: scale,
    });
    if (!grid) return null;
    const id = placement.printableAreaId;
    const pixels = cache ? cache.pixelsFor(id, source, placed.sourceVersion) : readPixels(source);
    const supersample = quality === 'final' && lw * lh <= MAX_SUPERSAMPLED_PIXELS ? 2 : 1;
    const warped = rasterizeWarp({
      grid,
      source: pixels,
      scale,
      originX,
      originY,
      width: lw,
      height: lh,
      supersample,
    });
    lctx.putImageData(new ImageData(warped.data, warped.width, warped.height), 0, 0);
  } else {
    // Boundary only: the placement itself is a plain rectangle or perspective quad.
    lctx.setTransform(scale, 0, 0, scale, -originX, -originY);
    if (placement.type === 'quad' && placement.corners) {
      drawQuad(lctx, source, placement.corners, width, height);
    } else {
      const w = placement.width * width;
      const h = placement.height * height;
      lctx.translate(
        (placement.x + placement.width / 2) * width,
        (placement.y + placement.height / 2) * height,
      );
      lctx.rotate((placement.rotation ?? 0) * DEG);
      lctx.drawImage(source, -w / 2, -h / 2, w, h);
    }
  }

  const mask = placement.mask;
  if (mask) {
    lctx.setTransform(scale, 0, 0, scale, -originX, -originY);
    lctx.globalCompositeOperation = 'destination-in';
    lctx.fillStyle = '#000';
    if (mask.type === 'path') {
      lctx.fill(bezierToPath2D(mask.path, width, height), mask.path.fillRule);
    } else if (placed.maskBitmap) {
      // The alpha channel is the coverage: destination-in multiplies, so partial alpha stays partial.
      lctx.drawImage(placed.maskBitmap, 0, 0, width, height);
    }
    lctx.globalCompositeOperation = 'source-over';
  }
  return { canvas, x: originX / scale, y: originY / scale, width: lw / scale, height: lh / scale };
}
