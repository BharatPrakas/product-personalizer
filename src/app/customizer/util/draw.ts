/**
 * Canvas 2D drawing of a `Scene`. One implementation serves the display preview, the artwork
 * export (scale 1, configured pixel size) and the preview export (mockup + scaled artwork).
 */

import { MockupPlacement } from '../models/config.models';
import { Scene } from './scene';

export interface SceneTransform {
  x: number;
  y: number;
  scale: number;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  transform: SceneTransform = { x: 0, y: 0, scale: 1 },
): void {
  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);
  // Everything is clipped to the print area.
  ctx.beginPath();
  ctx.rect(0, 0, scene.width, scene.height);
  ctx.clip();
  if (scene.background !== 'transparent') {
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const op of scene.ops) {
    if (op.kind === 'image') {
      ctx.drawImage(op.source, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh);
    } else {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  ctx.restore();
}

/** Mockup scaled to `width` x `height` with the artwork scene composited into its placement rectangle. */
export function drawComposite(
  ctx: CanvasRenderingContext2D,
  mockup: ImageBitmap,
  placement: MockupPlacement,
  scene: Scene,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mockup, 0, 0, width, height);
  ctx.restore();
  drawScene(ctx, scene, {
    x: placement.x * width,
    y: placement.y * height,
    scale: (placement.width * width) / scene.width,
  });
}
