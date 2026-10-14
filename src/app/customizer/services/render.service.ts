import { Service } from '@angular/core';
import { LIMITS, MockupPlacement, TextAlign } from '../models/config.models';
import { drawComposite, drawScene } from '../util/draw';
import { Scene } from '../util/scene';
import { InkBox } from '../util/text-fit';

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  return ctx;
}

/** Canvas 2D drawing and text measurement. Stateless apart from one scratch measuring context. */
@Service()
export class RenderService {
  private scratch: CanvasRenderingContext2D | null = null;

  /** Ink extents of `text` for a canvas font shorthand, as used by the text-fit routine. */
  readonly measure = (font: string, align: TextAlign, text: string): InkBox => {
    this.scratch ??= context(createCanvas(1, 1));
    const ctx = this.scratch;
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(text);
    return {
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
    };
  };

  /** Artwork only, at the configured canvas pixel size (scale 1). */
  renderArtwork(scene: Scene): HTMLCanvasElement {
    const canvas = createCanvas(scene.width, scene.height);
    drawScene(context(canvas), scene);
    return canvas;
  }

  /** Mockup with artwork composited in, longest edge at most 1200px. */
  renderPreview(mockup: ImageBitmap, placement: MockupPlacement, scene: Scene): HTMLCanvasElement {
    const scale = Math.min(1, LIMITS.previewMaxEdge / Math.max(mockup.width, mockup.height));
    const width = Math.max(1, Math.round(mockup.width * scale));
    const height = Math.max(1, Math.round(mockup.height * scale));
    const canvas = createCanvas(width, height);
    drawComposite(context(canvas), mockup, placement, scene, width, height);
    return canvas;
  }

  /** Repaint the on-screen preview canvas at its current backing-store size. */
  paintDisplay(
    canvas: HTMLCanvasElement,
    mockup: ImageBitmap,
    placement: MockupPlacement,
    scene: Scene,
  ): void {
    const ctx = context(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawComposite(ctx, mockup, placement, scene, canvas.width, canvas.height);
  }
}
