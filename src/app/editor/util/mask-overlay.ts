/**
 * Editing-only drawing of a raster boundary on the stage: a translucent tint and a thin ring that
 * traces its edge. Both are painted on a separate overlay canvas, so nothing here can reach an export.
 */

const scratch: HTMLCanvasElement[] = [];

function layer(index: number, width: number, height: number): CanvasRenderingContext2D {
  const canvas = (scratch[index] ??= document.createElement('canvas'));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tint the mask (its alpha channel) with `color` over `rect` (device pixels). */
export function drawMaskTint(
  target: CanvasRenderingContext2D,
  mask: CanvasImageSource & { width: number; height: number },
  rect: MaskRect,
  color: string,
): void {
  const { width, height } = target.canvas;
  if (width === 0 || height === 0 || mask.width === 0 || mask.height === 0) return;
  const t = layer(0, width, height);
  t.drawImage(mask, rect.x, rect.y, rect.width, rect.height);
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = color;
  t.fillRect(0, 0, width, height);
  target.drawImage(t.canvas, 0, 0);
}

/**
 * Trace the mask's edge with a ring that is a constant number of device pixels wide whatever the zoom
 * (it is made by offsetting the mask itself), with a dark halo so it shows on light photographs.
 */
export function drawMaskRing(
  target: CanvasRenderingContext2D,
  mask: CanvasImageSource & { width: number; height: number },
  rect: MaskRect,
  dpr: number,
  color = '#ffffff',
): void {
  const { width, height } = target.canvas;
  if (width === 0 || height === 0 || mask.width === 0 || mask.height === 0) return;
  const r = layer(1, width, height);
  const w = Math.max(1, Math.round(1.5 * dpr));
  for (const [ox, oy] of [
    [-w, 0],
    [w, 0],
    [0, -w],
    [0, w],
    [-w, -w],
    [w, w],
    [-w, w],
    [w, -w],
  ]) {
    r.drawImage(mask, rect.x + ox, rect.y + oy, rect.width, rect.height);
  }
  r.globalCompositeOperation = 'destination-out';
  r.drawImage(mask, rect.x, rect.y, rect.width, rect.height);
  // Halo first (underneath), then the coloured ring on top.
  const h = layer(2, width, height);
  h.drawImage(r.canvas, 1, 1);
  h.globalCompositeOperation = 'source-in';
  h.fillStyle = 'rgba(15, 23, 42, 0.85)';
  h.fillRect(0, 0, width, height);
  target.drawImage(h.canvas, 0, 0);
  r.globalCompositeOperation = 'source-in';
  r.fillStyle = color;
  r.fillRect(0, 0, width, height);
  target.drawImage(r.canvas, 0, 0);
}
