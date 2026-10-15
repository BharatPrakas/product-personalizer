import { Service } from '@angular/core';
import { LIMITS, TextAlign } from '../models/config.models';
import type { AreaPlacement, ProductMockup } from '../models/product.models';
import {
  CompositeInput,
  CompositeOverlay,
  PRODUCTION,
  PlacedArea,
  drawAreaScene,
  drawComposite,
  placementPixelSize,
} from '../util/draw';
import { AreaScene, sceneSignature } from '../util/scene';
import { InkBox } from '../util/text-fit';
import { TextMeasurer } from '../util/text-layout';

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

/** A mockup with the scenes of the printable areas placed on it: everything the preview needs. */
export interface PreviewComposite {
  mockup: ProductMockup;
  bitmap: ImageBitmap;
  background?: string;
  areas: { placement: AreaPlacement; scene: AreaScene }[];
  overlays: CompositeOverlay[];
}

interface CacheEntry {
  key: string;
  canvas: HTMLCanvasElement;
}

/**
 * Per-preview cache of rendered printable-area canvases. An area is re-rendered only when its
 * scene (or the size it is drawn at) actually changed, so typing in one field never repaints the
 * other areas' artwork.
 */
export class AreaCanvasCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** Redraws counted since creation; lets the editor and tests observe cache effectiveness. */
  renders = 0;

  get(scene: AreaScene, width: number, height: number): HTMLCanvasElement {
    const key = `${sceneSignature(scene)}|${width}x${height}`;
    const cached = this.entries.get(scene.areaId);
    if (cached && cached.key === key) return cached.canvas;
    const canvas = cached?.canvas ?? createCanvas(width, height);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    } else {
      context(canvas).clearRect(0, 0, width, height);
    }
    drawAreaScene(
      context(canvas),
      scene,
      { includePreviewOnly: true },
      {
        x: 0,
        y: 0,
        scale: width / scene.width,
      },
    );
    this.renders++;
    this.entries.set(scene.areaId, { key, canvas });
    return canvas;
  }

  /** Drop entries for areas that are no longer shown. */
  retain(areaIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (areaIds.has(id)) continue;
      entry.canvas.width = entry.canvas.height = 0;
      this.entries.delete(id);
    }
  }

  dispose(): void {
    this.retain(new Set());
  }
}

/** Canvas 2D drawing and text measurement. Stateless apart from one scratch measuring context. */
@Service()
export class RenderService {
  private scratch: CanvasRenderingContext2D | null = null;

  private scratchContext(): CanvasRenderingContext2D {
    this.scratch ??= context(createCanvas(1, 1));
    return this.scratch;
  }

  /** Ink extents of `text` for a canvas font shorthand, as used by the text-fit routine. */
  readonly measure = (font: string, align: TextAlign, text: string): InkBox => {
    const ctx = this.scratchContext();
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

  readonly measurer: TextMeasurer = {
    ink: this.measure,
    width: (font, text) => {
      const ctx = this.scratchContext();
      ctx.font = font;
      return ctx.measureText(text).width;
    },
  };

  /**
   * Production artwork of one printable area: its own canvas at its configured pixel size, masked
   * to the area shape, with no mockup, no placeholders and no editing aids.
   */
  renderAreaArtwork(scene: AreaScene): HTMLCanvasElement {
    const canvas = createCanvas(scene.width, scene.height);
    drawAreaScene(context(canvas), scene, PRODUCTION);
    return canvas;
  }

  /** Composite product preview (customer-facing: includes empty-slot placeholders when asked). */
  renderPreview(
    composite: PreviewComposite,
    options: { maxEdge?: number; includePreviewOnly?: boolean } = {},
  ): HTMLCanvasElement {
    const maxEdge = options.maxEdge ?? LIMITS.previewMaxEdge;
    const { bitmap } = composite;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = createCanvas(width, height);
    const temporary: HTMLCanvasElement[] = [];
    try {
      const input = this.compositeInput(composite, width, height, (scene, w, h) => {
        const areaCanvas = createCanvas(w, h);
        temporary.push(areaCanvas);
        drawAreaScene(
          context(areaCanvas),
          scene,
          { includePreviewOnly: options.includePreviewOnly ?? false },
          { x: 0, y: 0, scale: w / scene.width },
        );
        return areaCanvas;
      });
      drawComposite(context(canvas), input, width, height);
    } finally {
      for (const area of temporary) area.width = area.height = 0;
    }
    return canvas;
  }

  /** Repaint the on-screen preview canvas at its current backing-store size. */
  paintDisplay(
    canvas: HTMLCanvasElement,
    composite: PreviewComposite,
    cache: AreaCanvasCache,
  ): void {
    const ctx = context(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const input = this.compositeInput(composite, canvas.width, canvas.height, (scene, w, h) =>
      cache.get(scene, w, h),
    );
    drawComposite(ctx, input, canvas.width, canvas.height);
    cache.retain(new Set(composite.areas.map((a) => a.scene.areaId)));
  }

  /**
   * Paint into a context whose transform maps the mockup's pixel space (`width` x `height`) to the
   * screen. `detail` is the number of device pixels per mockup pixel, so area canvases are rendered
   * sharply however far the editor is zoomed in.
   */
  paintComposite(
    ctx: CanvasRenderingContext2D,
    composite: PreviewComposite,
    cache: AreaCanvasCache,
    width: number,
    height: number,
    detail: number,
  ): void {
    const input = this.compositeInput(
      composite,
      width,
      height,
      (scene, w, h) => cache.get(scene, w, h),
      detail,
    );
    drawComposite(ctx, input, width, height);
    cache.retain(new Set(composite.areas.map((a) => a.scene.areaId)));
  }

  private compositeInput(
    composite: PreviewComposite,
    width: number,
    height: number,
    areaCanvas: (scene: AreaScene, w: number, h: number) => HTMLCanvasElement,
    detail = 1,
  ): CompositeInput {
    const areas: PlacedArea[] = composite.areas.map(({ placement, scene }) => {
      const placed = placementPixelSize(placement, width, height);
      const target = { w: placed.w * detail, h: placed.h * detail };
      const scale = Math.min(1, Math.max(target.w / scene.width, target.h / scene.height));
      const w = Math.max(8, Math.round(scene.width * scale));
      const h = Math.max(8, Math.round(scene.height * scale));
      return { placement, source: areaCanvas(scene, w, h) };
    });
    return {
      mockup: composite.bitmap,
      background: composite.background,
      areas,
      overlays: composite.overlays,
    };
  }
}
