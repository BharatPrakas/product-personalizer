import { computed, signal } from '@angular/core';
import { Pt } from '../util/box-math';
import { drawMaskRing, drawMaskTint } from '../util/mask-overlay';
import { MaskPainter } from '../util/mask-painter';

import { PointerResult, ToolHost, ViewTransform } from './tool-host';

/**
 * The Brush Mask tool: paints the raster printable boundary of an area straight onto the product
 * photograph. The mask lives in a `MaskPainter` (a canvas at the photo's resolution) while editing;
 * when a stroke ends it is encoded to a lossless PNG, stored as an ordinary image asset and the
 * placement's `mask.src` is updated, which makes every stroke one undo step.
 */
export class BrushTool {
  private painter: MaskPainter | null = null;
  /** The pointer position in screen pixels, for the brush outline. */
  readonly cursor = signal<{ x: number; y: number } | null>(null);
  /** Bumped whenever the painted mask changes so the overlay repaints. */
  readonly version = signal(0);
  private queue: Promise<void> = Promise.resolve();
  private painting = false;
  /**
   * False while an existing raster boundary is still being decoded: painting is refused until it is
   * loaded, so a stroke can never overwrite a mask that has not been read yet.
   */
  readonly loaded = signal(true);

  constructor(private readonly host: ToolHost) {}

  private get store() {
    return this.host.store;
  }

  /** Brush outline radius on screen, so the circle matches what a stroke will cover at this zoom. */
  readonly cursorRadius = computed(
    () => (this.store.brush().size / 2) * this.host.transform().scale,
  );

  /** Load the area's current boundary into the painter (a raster mask, or an outline to refine). */
  begin(): void {
    this.painter?.dispose();
    this.painter = null;
    const c = this.host.content();
    const tool = this.store.tool();
    if (!c || tool.kind !== 'brush') return;
    this.painter = new MaskPainter(c.w, c.h);
    this.loaded.set(false);
    this.tryLoad();
  }

  /** Fill the painter from the stored boundary once it is available. */
  tryLoad(): void {
    const painter = this.painter;
    const tool = this.store.tool();
    if (!painter || tool.kind !== 'brush') return;
    const mask = tool.areaId ? this.store.placementFor(tool.areaId)?.mask : undefined;
    if (mask?.type === 'raster') {
      const resolved = this.resolvedMaskSrc(tool.areaId!);
      const bitmap = resolved ? this.store.assets.staticImages().get(resolved) : undefined;
      if (!bitmap) return;
      painter.load(bitmap);
    } else if (mask?.type === 'path') {
      painter.loadPath(mask.path);
    }
    this.loaded.set(true);
    this.version.update((n) => n + 1);
  }

  private resolvedMaskSrc(areaId: string): string | null {
    const mockupId = this.store.mockup()?.id;
    const placement = this.store
      .resolvedConfig()
      ?.mockups.find((m) => m.id === mockupId)
      ?.placements.find((p) => p.printableAreaId === areaId);
    return placement?.mask?.type === 'raster' ? placement.mask.src : null;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.painter?.canvas ?? null;
  }

  dispose(): void {
    this.painter?.dispose();
    this.painter = null;
  }

  // ---- pointer -----------------------------------------------------------------------------------------

  down(content: Pt, screen: Pt): PointerResult {
    if (!this.painter || !this.loaded()) return { handled: false };
    this.painting = true;
    this.store.interacting.set(true);
    this.painter.begin(content.x, content.y, this.store.brush());
    this.cursor.set(screen);
    this.version.update((n) => n + 1);
    return { handled: true };
  }

  move(content: Pt, screen: Pt): void {
    this.cursor.set(screen);
    if (!this.painting || !this.painter) return;
    this.painter.extend(content.x, content.y, this.store.brush());
    this.version.update((n) => n + 1);
  }

  hover(screen: Pt | null): void {
    this.cursor.set(screen);
  }

  up(): void {
    if (!this.painting) return;
    this.painting = false;
    this.painter?.end();
    this.store.interacting.set(false);
    this.enqueueCommit();
  }

  // ---- actions -----------------------------------------------------------------------------------------

  /** Remove everything painted (and the boundary). */
  clear(): void {
    if (!this.painter) return;
    this.painter.clear();
    this.version.update((n) => n + 1);
    this.enqueueCommit();
  }

  /** Fit the placement rectangle to the painted region (the artwork then fills it). */
  fitPlacement(): void {
    const tool = this.store.tool();
    const bounds = this.painter?.bounds();
    if (tool.kind !== 'brush' || !tool.areaId || !bounds) return;
    this.store.patchPlacement(tool.areaId, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      rotation: undefined,
    });
  }

  exit(): void {
    this.store.tool.set({ kind: 'select' });
  }

  private enqueueCommit(): void {
    this.queue = this.queue.then(() => this.commit()).catch(() => undefined);
  }

  private async commit(): Promise<void> {
    const painter = this.painter;
    const c = this.host.content();
    if (!painter || !c) return;
    const tool = this.store.tool();
    if (tool.kind !== 'brush') return;
    const bounds = painter.bounds();
    if (!bounds) {
      // Nothing left: the area has no boundary any more (a new area is not created from nothing).
      if (tool.areaId) this.store.patchPlacement(tool.areaId, { mask: undefined });
      return;
    }
    const blob = await painter.toBlob();
    const bitmap = await createImageBitmap(painter.canvas);
    const src = await this.store.uploadImage(
      new File([blob], 'boundary-mask.png', { type: 'image/png' }),
    );
    if (!src) {
      bitmap.close();
      return;
    }
    this.store.adoptStaticBitmap(src, bitmap);
    const mask = { type: 'raster' as const, src, width: painter.width, height: painter.height };
    if (tool.areaId) {
      this.store.patchPlacement(tool.areaId, { mask }, `brush:${tool.areaId}`);
      this.store.breakCoalescing();
      return;
    }
    // The first stroke of a new area: the placement is the region that was painted.
    const id = this.store.addAreaOnMockup(
      { type: 'rect' },
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      c,
      { mask },
    );
    if (id) this.store.tool.set({ kind: 'brush', areaId: id });
  }

  /** Paint the translucent mask and its boundary ring onto the stage overlay. */
  paint(target: HTMLCanvasElement, t: ViewTransform, dpr: number): void {
    const ctx = target.getContext('2d');
    const painter = this.painter;
    const c = this.host.content();
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    if (!painter || !c) return;
    const rect = {
      x: t.tx * dpr,
      y: t.ty * dpr,
      width: c.w * t.scale * dpr,
      height: c.h * t.scale * dpr,
    };
    drawMaskTint(ctx, painter.canvas, rect, 'rgba(37, 99, 235, 0.38)');
    drawMaskRing(ctx, painter.canvas, rect, dpr);
  }
}
