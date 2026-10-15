/**
 * Canvas 2D drawing. One implementation serves every output: the on-screen preview, the merchant
 * editor, the production artwork of each printable area (scale 1, no previews-only content) and
 * the combined product preview.
 */

import type { AreaPlacement, BlendMode, MockupOverlay, Point } from '../models/product.models';
import { DEG, boxCenter, clipToShape, shapePath } from './geometry';
import { AreaScene, ImageOp, PlaceholderOp, SceneOp, ShapeOp, TextOp } from './scene';

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
  for (const placed of input.areas) drawPlaced(ctx, placed, width, height);
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
  { placement, source }: PlacedArea,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.globalAlpha = placement.opacity ?? 1;
  ctx.globalCompositeOperation = BLEND[placement.blendMode ?? 'normal'];
  if (placement.type === 'quad' && placement.corners) {
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

/** Projective map of the unit square onto `quad` (Heckbert), as 8 coefficients. */
function squareToQuad(q: readonly [Point, Point, Point, Point]): number[] | null {
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
  const project = (u: number, v: number): [number, number] => {
    const w = m[6] * u + m[7] * v + 1;
    return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
  };
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
