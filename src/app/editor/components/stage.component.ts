import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AreaPlacement, BoundarySpec, ShapeSpec } from '../../customizer/models/product.models';
import { drawAreaScene } from '../../customizer/util/draw';
import { AreaCanvasCache, RenderService } from '../../customizer/services/render.service';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import {
  HandleId,
  Pt,
  RBox,
  RESIZE_HANDLES,
  clamp,
  containsPoint,
  corners,
  handlePoints,
  moveBox,
  resizeBox,
  rotateBox,
  round,
} from '../util/box-math';

type Corners = NonNullable<AreaPlacement['corners']>;

interface StageItem {
  /** Area id (mockup view) or layer id (artwork view). */
  id: string;
  label: string;
  box: RBox;
  locked: boolean;
  shape: ShapeSpec;
  boundary: BoundarySpec | null;
  /** Content-space corners of a perspective placement. */
  quad: Pt[] | null;
}

interface Outline {
  id: string;
  kind: 'rect' | 'ellipse' | 'path' | 'polygon';
  transform: string;
  w: number;
  h: number;
  rx: number;
  d: string;
  pathTransform: string;
  polygon: string;
  stroke: string;
  opacity: number;
  selected: boolean;
}

interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

type Drag =
  | { kind: 'pan'; x: number; y: number; tx: number; ty: number }
  | {
      kind: 'move' | 'resize' | 'rotate';
      item: StageItem;
      start: RBox;
      pointer: Pt;
      handle?: HandleId;
    }
  | { kind: 'corner'; item: StageItem; index: number; quad: Pt[] }
  | { kind: 'draw'; shape: ShapeSpec['type']; from: Pt; to: Pt };

const PAD = 28;
const HANDLE_PX = 9;
const ROTATE_GAP_PX = 30;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

const CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  rotate: 'grab',
};

/**
 * The interactive canvas: the mockup (with every printable area composed onto it) or one area's
 * production canvas (with its layers). Rendering uses the same engine as the storefront; selection
 * outlines, handles and guides are an SVG overlay so they never appear in any export.
 */
@Component({
  selector: 'app-stage',
  templateUrl: './stage.component.html',
  styleUrl: './stage.component.scss',
})
export class StageComponent {
  protected readonly store = inject(EditorStore);
  private readonly render = inject(RenderService);
  private readonly cache = new AreaCanvasCache();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly overlayRef = viewChild.required<ElementRef<SVGSVGElement>>('overlay');
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('host');

  private readonly size = signal({ w: 0, h: 0 });
  private readonly dpr = signal(1);
  readonly transform = signal<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  private userZoomed = false;
  private drag: Drag | null = null;
  private spaceDown = false;

  protected readonly guides = signal<{ x1: number; y1: number; x2: number; y2: number }[]>([]);
  private readonly drawing = signal<{ shape: ShapeSpec['type']; from: Pt; to: Pt } | null>(null);
  private readonly hoverHandle = signal<HandleId | null>(null);
  private readonly panning = signal(false);

  // ---- content ---------------------------------------------------------------------------------

  /** Size of what is shown, in its own units (mockup pixels or canvas pixels). */
  protected readonly content = computed<{ w: number; h: number } | null>(() => {
    if (this.store.view() === 'mockup') {
      const mockup = this.store.mockup();
      return mockup ? this.store.mockupSize(mockup.id) : null;
    }
    const area = this.store.area();
    return area ? { w: area.canvas.width, h: area.canvas.height } : null;
  });

  private readonly items = computed<StageItem[]>(() => {
    const config = this.store.config();
    const content = this.content();
    if (!config || !content) return [];
    if (this.store.view() === 'mockup') {
      const mockup = this.store.mockup();
      return (mockup?.placements ?? []).flatMap((p): StageItem[] => {
        const area = config.printableAreas.find((a) => a.id === p.printableAreaId);
        if (!area) return [];
        const w = p.width * content.w;
        const h = p.height * content.h;
        return [
          {
            id: area.id,
            label: area.name,
            box: {
              cx: p.x * content.w + w / 2,
              cy: p.y * content.h + h / 2,
              w,
              h,
              rot: p.rotation ?? 0,
            },
            locked: false,
            shape: area.shape,
            boundary: area.boundary ?? null,
            quad:
              p.type === 'quad' && p.corners
                ? p.corners.map(([x, y]) => ({ x: x * content.w, y: y * content.h }))
                : null,
          },
        ];
      });
    }
    return (this.store.artwork()?.layers ?? [])
      .filter((l) => l.visible !== false)
      .map((l): StageItem => ({
        id: l.id,
        label: l.name ?? l.type,
        box: {
          cx: l.x + l.width / 2,
          cy: l.y + l.height / 2,
          w: l.width,
          h: l.height,
          rot: l.rotation ?? 0,
        },
        locked: l.locked === true,
        shape: l.type === 'shape' ? l.shape : (l.clip ?? { type: 'rect' }),
        boundary: null,
        quad: null,
      }));
  });

  private readonly selectedItem = computed<StageItem | null>(() => {
    const s = this.store.selection();
    const wanted =
      this.store.view() === 'mockup'
        ? s.kind === 'area'
          ? s.id
          : null
        : s.kind === 'layer'
          ? s.id
          : null;
    return wanted ? (this.items().find((i) => i.id === wanted) ?? null) : null;
  });

  protected readonly ariaLabel = computed(() => {
    const selected = this.selectedItem();
    const view = this.store.view() === 'mockup' ? 'Mockup canvas' : 'Artwork canvas';
    return `${view}. ${selected ? `${selected.label} selected. Use the arrow keys to move it, or the properties panel for exact values.` : 'Nothing selected.'}`;
  });

  protected readonly message = computed(() => {
    if (this.store.tool().kind === 'draw') return 'Drag on the mockup to draw the printable area.';
    if (!this.content()) return 'Loading image…';
    if (this.store.assetErrors().length > 0)
      return `${this.store.assetErrors().length} image(s) could not be loaded.`;
    return null;
  });

  protected readonly zoomLabel = computed(() => `${Math.round(this.transform().scale * 100)}%`);

  protected readonly cursor = computed(() => {
    if (this.panning()) return 'grabbing';
    if (this.store.tool().kind === 'draw') return 'crosshair';
    const handle = this.hoverHandle();
    return handle ? CURSORS[handle] : 'default';
  });

  // ---- overlay geometry (screen space) ---------------------------------------------------------------

  private toScreen(p: Pt, t: ViewTransform = this.transform()): Pt {
    return { x: p.x * t.scale + t.tx, y: p.y * t.scale + t.ty };
  }

  protected readonly outlines = computed(() => {
    const t = this.transform();
    const selected = this.selectedItem()?.id;
    const showBoundary = this.store.showBoundaries();
    const mockupView = this.store.view() === 'mockup';
    return this.items().flatMap((item): Outline[] => {
      const isSelected = item.id === selected;
      if (mockupView && !showBoundary && !isSelected) return [];
      if (!mockupView && !isSelected) return [];
      const color = item.boundary?.color ?? '#2563eb';
      const opacity = mockupView ? (isSelected ? 1 : (item.boundary?.opacity ?? 0.85)) : 0.9;
      if (item.quad) {
        const pts = item.quad.map((p) => this.toScreen(p, t));
        return [
          {
            id: item.id,
            kind: 'polygon',
            transform: '',
            w: 0,
            h: 0,
            rx: 0,
            d: '',
            pathTransform: '',
            polygon: pts.map((p) => `${p.x},${p.y}`).join(' '),
            stroke: color,
            opacity,
            selected: isSelected,
          },
        ];
      }
      const c = this.toScreen({ x: item.box.cx, y: item.box.cy }, t);
      const w = item.box.w * t.scale;
      const h = item.box.h * t.scale;
      const shape = item.shape;
      return [
        {
          id: item.id,
          kind: shape.type,
          transform: `translate(${c.x} ${c.y}) rotate(${item.box.rot})`,
          w,
          h,
          rx: shape.type === 'rect' ? (shape.cornerRadius ?? 0) * Math.min(w, h) : 0,
          d: shape.type === 'path' ? shape.d : '',
          pathTransform:
            shape.type === 'path'
              ? `translate(${-w / 2} ${-h / 2}) scale(${w / shape.viewBox[0]} ${h / shape.viewBox[1]})`
              : '',
          polygon: '',
          stroke: color,
          opacity,
          selected: isSelected,
        },
      ];
    });
  });

  protected readonly frame = computed(() => {
    const item = this.selectedItem();
    if (!item || this.store.tool().kind === 'draw') return null;
    const t = this.transform();
    if (item.quad) {
      const pts = item.quad.map((p) => this.toScreen(p, t));
      return {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        rotateLine: null,
        handles: pts.map((p, i) => ({ id: `q${i}` as const, x: p.x, y: p.y })),
      };
    }
    const cs = corners(item.box).map((p) => this.toScreen(p, t));
    const hp = handlePoints(item.box, ROTATE_GAP_PX / t.scale);
    const top = this.toScreen(hp['n'], t);
    const rot = this.toScreen(hp['rotate'], t);
    const locked = item.locked;
    return {
      points: cs.map((p) => `${p.x},${p.y}`).join(' '),
      rotateLine: locked ? null : { x1: top.x, y1: top.y, x2: rot.x, y2: rot.y },
      handles: locked
        ? []
        : [...RESIZE_HANDLES, 'rotate' as const].map((id) => {
            const p = this.toScreen(hp[id], t);
            return { id, x: p.x, y: p.y };
          }),
    };
  });

  protected readonly draft = computed(() => {
    const d = this.drawing();
    if (!d) return null;
    const a = this.toScreen(d.from);
    const b = this.toScreen(d.to);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    return {
      shape: d.shape,
      w,
      h,
      transform: `translate(${Math.min(a.x, b.x) + w / 2} ${Math.min(a.y, b.y) + h / 2})`,
    };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.cache.dispose());

    afterNextRender(() => {
      const host = this.hostRef().nativeElement;
      const update = () => {
        this.size.set({ w: host.clientWidth, h: host.clientHeight });
        this.dpr.set(Math.min(window.devicePixelRatio || 1, 2.5));
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
      const wheel = (event: WheelEvent) => this.onWheel(event);
      this.overlayRef().nativeElement.addEventListener('wheel', wheel, { passive: false });
      const keyUp = (event: KeyboardEvent) => {
        if (event.code === 'Space') this.spaceDown = false;
      };
      window.addEventListener('keyup', keyUp);
      destroyRef.onDestroy(() => window.removeEventListener('keyup', keyUp));
    });

    // Fit whenever the thing shown (or the stage size) changes, unless the merchant zoomed by hand.
    effect(() => {
      const content = this.content();
      const size = this.size();
      this.store.view();
      this.store.mockup()?.id;
      this.store.area()?.id;
      if (!content || size.w === 0) return;
      untracked(() => {
        if (!this.userZoomed || !this.fitIsValid(content, size)) this.fit();
      });
    });

    // Repaint.
    effect(() => {
      const size = this.size();
      const dpr = this.dpr();
      const t = this.transform();
      const view = this.store.view();
      const evaluation = this.store.evaluation();
      const mockup = this.store.mockup();
      const area = this.store.area();
      this.store.assets.staticImages();
      if (size.w === 0) return;
      const canvas = this.canvasRef().nativeElement;
      const width = Math.round(size.w * dpr);
      const height = Math.round(size.h * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx || !evaluation) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (view === 'mockup' && mockup) {
        const composite = this.store.composite(mockup.id);
        if (!composite) return;
        ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.tx, dpr * t.ty);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, composite.bitmap.width, composite.bitmap.height);
        this.render.paintComposite(
          ctx,
          composite,
          this.cache,
          composite.bitmap.width,
          composite.bitmap.height,
          dpr * t.scale,
        );
      } else if (view === 'artwork' && area) {
        const scene = evaluation.areas.find((s) => s.areaId === area.id);
        if (!scene) return;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 14 * dpr;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(
          dpr * t.tx,
          dpr * t.ty,
          scene.width * t.scale * dpr,
          scene.height * t.scale * dpr,
        );
        ctx.restore();
        drawAreaScene(
          ctx,
          scene,
          { includePreviewOnly: true, checkerboard: true },
          { x: dpr * t.tx, y: dpr * t.ty, scale: dpr * t.scale },
        );
        ctx.strokeStyle = 'rgba(15,23,42,0.35)';
        ctx.lineWidth = dpr;
        ctx.strokeRect(
          dpr * t.tx,
          dpr * t.ty,
          scene.width * t.scale * dpr,
          scene.height * t.scale * dpr,
        );
      }
    });
  }

  // ---- zoom and pan -------------------------------------------------------------------------------

  private fitIsValid(content: { w: number; h: number }, size: { w: number; h: number }): boolean {
    const t = this.transform();
    return content.w * t.scale > 4 && content.h * t.scale > 4 && size.w > 0;
  }

  fit(): void {
    const content = this.content();
    const size = this.size();
    if (!content || size.w === 0) return;
    const scale = clamp(
      Math.min((size.w - PAD * 2) / content.w, (size.h - PAD * 2) / content.h),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.userZoomed = false;
    this.transform.set({
      scale,
      tx: (size.w - content.w * scale) / 2,
      ty: (size.h - content.h * scale) / 2,
    });
  }

  zoomBy(factor: number, anchor?: Pt): void {
    const size = this.size();
    const t = this.transform();
    const at = anchor ?? { x: size.w / 2, y: size.h / 2 };
    const scale = clamp(t.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const k = scale / t.scale;
    this.userZoomed = true;
    this.transform.set({ scale, tx: at.x - (at.x - t.tx) * k, ty: at.y - (at.y - t.ty) * k });
  }

  zoomActual(): void {
    this.zoomBy(1 / this.transform().scale);
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = this.overlayRef().nativeElement.getBoundingClientRect();
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      this.zoomBy(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), anchor);
    } else {
      this.userZoomed = true;
      this.transform.update((t) => ({ ...t, tx: t.tx - event.deltaX, ty: t.ty - event.deltaY }));
    }
  }

  // ---- pointer interaction ------------------------------------------------------------------------------

  private pointer(event: PointerEvent): { screen: Pt; content: Pt } {
    const rect = this.overlayRef().nativeElement.getBoundingClientRect();
    const t = this.transform();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return { screen, content: { x: (screen.x - t.tx) / t.scale, y: (screen.y - t.ty) / t.scale } };
  }

  protected onDown(event: PointerEvent): void {
    this.overlayRef().nativeElement.focus({ preventScroll: true });
    const { screen, content } = this.pointer(event);
    const target = this.overlayRef().nativeElement;
    const capture = () => target.setPointerCapture(event.pointerId);

    if (event.button === 1 || this.spaceDown) {
      capture();
      this.panning.set(true);
      const t = this.transform();
      this.drag = { kind: 'pan', x: screen.x, y: screen.y, tx: t.tx, ty: t.ty };
      return;
    }
    if (event.button !== 0) return;

    const tool = this.store.tool();
    if (tool.kind === 'draw' && this.store.view() === 'mockup') {
      capture();
      this.drag = { kind: 'draw', shape: tool.shape, from: content, to: content };
      this.drawing.set({ shape: tool.shape, from: content, to: content });
      return;
    }

    // Handles of the current selection come first.
    const selected = this.selectedItem();
    if (selected && !selected.locked) {
      const grabbed = this.handleAt(selected, screen);
      if (grabbed) {
        capture();
        if (grabbed.quadIndex !== undefined && selected.quad) {
          this.drag = {
            kind: 'corner',
            item: selected,
            index: grabbed.quadIndex,
            quad: selected.quad,
          };
        } else if (grabbed.handle === 'rotate') {
          this.drag = { kind: 'rotate', item: selected, start: selected.box, pointer: content };
        } else if (grabbed.handle) {
          this.drag = {
            kind: 'resize',
            item: selected,
            start: selected.box,
            pointer: content,
            handle: grabbed.handle,
          };
        }
        return;
      }
    }

    const hit = this.hitTest(content);
    if (hit) {
      this.selectItem(hit);
      if (!hit.locked) {
        capture();
        this.drag = { kind: 'move', item: hit, start: hit.box, pointer: content };
      }
      return;
    }
    // Empty space: deselect and pan.
    this.store.select(
      this.store.view() === 'mockup'
        ? { kind: 'mockup', id: this.store.mockup()?.id ?? '' }
        : { kind: 'artwork', id: this.store.artwork()?.id ?? '' },
    );
    capture();
    this.panning.set(true);
    const t = this.transform();
    this.drag = { kind: 'pan', x: screen.x, y: screen.y, tx: t.tx, ty: t.ty };
  }

  protected onMove(event: PointerEvent): void {
    const { screen, content } = this.pointer(event);
    const drag = this.drag;
    if (!drag) {
      const selected = this.selectedItem();
      this.hoverHandle.set(
        selected && !selected.locked ? (this.handleAt(selected, screen)?.handle ?? null) : null,
      );
      return;
    }
    switch (drag.kind) {
      case 'pan':
        this.userZoomed = true;
        this.transform.update((t) => ({
          ...t,
          tx: drag.tx + screen.x - drag.x,
          ty: drag.ty + screen.y - drag.y,
        }));
        break;
      case 'draw':
        drag.to = content;
        this.drawing.set({ shape: drag.shape, from: drag.from, to: content });
        break;
      case 'move': {
        let box = moveBox(drag.start, content.x - drag.pointer.x, content.y - drag.pointer.y);
        box = this.snap(box, event.altKey);
        this.apply(drag.item, box);
        break;
      }
      case 'resize': {
        const lock = this.lockAspect(drag.item, event.shiftKey);
        const box = resizeBox(drag.start, drag.handle as Exclude<HandleId, 'rotate'>, content, {
          lockAspect: lock,
          fromCenter: event.altKey,
          min: this.store.view() === 'mockup' ? 8 : 4,
        });
        this.apply(drag.item, box);
        break;
      }
      case 'rotate':
        this.apply(drag.item, rotateBox(drag.start, content, event.shiftKey));
        break;
      case 'corner': {
        const quad = drag.quad.map((p, i) => (i === drag.index ? content : p));
        this.applyQuad(drag.item, quad);
        break;
      }
    }
  }

  protected onUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    this.panning.set(false);
    this.guides.set([]);
    const target = this.overlayRef().nativeElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (!drag) return;
    if (drag.kind === 'draw') this.finishDraw(drag);
    else if (drag.kind !== 'pan') this.store.breakCoalescing();
  }

  protected onKey(event: KeyboardEvent): void {
    const selected = this.selectedItem();
    if (event.code === 'Space') {
      this.spaceDown = true;
      event.preventDefault();
      return;
    }
    if (event.key === '+' || event.key === '=') return this.consume(event, () => this.zoomBy(1.2));
    if (event.key === '-') return this.consume(event, () => this.zoomBy(1 / 1.2));
    if (event.key === '0') return this.consume(event, () => this.fit());
    if (event.key === 'Escape') {
      this.store.tool.set({ kind: 'select' });
      this.drawing.set(null);
      return;
    }
    if (!selected || selected.locked) return;
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (move) {
      this.consume(event, () => {
        // In the mockup view one step is one mockup pixel; in the artwork view one canvas pixel.
        this.apply(selected, moveBox(selected.box, move[0], move[1]), `key:${selected.id}`);
      });
    } else if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      this.store.view() === 'artwork'
    ) {
      this.consume(event, () => this.store.edit((c) => edit.removeLayer(c, selected.id)));
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'd' &&
      this.store.view() === 'artwork'
    ) {
      this.consume(event, () => {
        let created = '';
        this.store.edit((c) => {
          const r = edit.duplicateLayer(c, selected.id);
          created = r?.layerId ?? '';
          return r?.config ?? c;
        });
        if (created) this.store.select({ kind: 'layer', id: created });
      });
    }
  }

  private consume(event: Event, fn: () => void): void {
    event.preventDefault();
    fn();
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  private hitTest(point: Pt): StageItem | null {
    const items = this.items();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.quad ? pointInPolygon(point, item.quad) : containsPoint(item.box, point))
        return item;
    }
    return null;
  }

  private selectItem(item: StageItem): void {
    this.store.select(
      this.store.view() === 'mockup'
        ? { kind: 'area', id: item.id }
        : { kind: 'layer', id: item.id },
    );
  }

  private handleAt(item: StageItem, screen: Pt): { handle?: HandleId; quadIndex?: number } | null {
    const t = this.transform();
    if (item.quad) {
      const index = item.quad.findIndex((p) => {
        const s = this.toScreen(p, t);
        return Math.hypot(s.x - screen.x, s.y - screen.y) <= HANDLE_PX + 3;
      });
      return index >= 0 ? { quadIndex: index } : null;
    }
    const points = handlePoints(item.box, ROTATE_GAP_PX / t.scale);
    for (const id of ['rotate', ...RESIZE_HANDLES] as HandleId[]) {
      const s = this.toScreen(points[id], t);
      if (Math.hypot(s.x - screen.x, s.y - screen.y) <= HANDLE_PX + 3) return { handle: id };
    }
    return null;
  }

  /** Placements keep the area's canvas aspect unless Shift is held; layers are free unless Shift is held. */
  private lockAspect(item: StageItem, shift: boolean): boolean {
    return this.store.view() === 'mockup' ? !shift : shift;
  }

  private snap(box: RBox, disabled: boolean): RBox {
    this.guides.set([]);
    const content = this.content();
    if (disabled || !content || this.store.view() !== 'artwork' || box.rot % 90 !== 0) return box;
    const t = this.transform();
    const threshold = 6 / t.scale;
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    let { cx, cy } = box;
    const targetsX = [content.w / 2, 0, content.w];
    const targetsY = [content.h / 2, 0, content.h];
    const pointsX = [cx, cx - box.w / 2, cx + box.w / 2];
    const pointsY = [cy, cy - box.h / 2, cy + box.h / 2];
    for (const target of targetsX) {
      const hit = pointsX.findIndex((p) => Math.abs(p - target) < threshold);
      if (hit >= 0) {
        cx += target - pointsX[hit];
        const s = this.toScreen({ x: target, y: 0 });
        lines.push({ x1: s.x, y1: 0, x2: s.x, y2: this.size().h });
        break;
      }
    }
    for (const target of targetsY) {
      const hit = pointsY.findIndex((p) => Math.abs(p - target) < threshold);
      if (hit >= 0) {
        cy += target - pointsY[hit];
        const s = this.toScreen({ x: 0, y: target });
        lines.push({ x1: 0, y1: s.y, x2: this.size().w, y2: s.y });
        break;
      }
    }
    this.guides.set(lines);
    return { ...box, cx, cy };
  }

  private apply(item: StageItem, box: RBox, coalesce?: string): void {
    const content = this.content();
    if (!content) return;
    const key = coalesce ?? `drag:${item.id}`;
    if (this.store.view() === 'mockup') {
      const mockupId = this.store.mockup()?.id;
      if (!mockupId) return;
      const placement = this.store.placementFor(item.id);
      if (placement?.type === 'quad' && placement.corners) {
        const dx = (box.cx - item.box.cx) / content.w;
        const dy = (box.cy - item.box.cy) / content.h;
        const moved = placement.corners.map(([x, y]) => [
          round(x + dx, 5),
          round(y + dy, 5),
        ]) as unknown as Corners;
        this.store.edit((c) => edit.updatePlacement(c, mockupId, item.id, quadPatch(moved)), key);
        return;
      }
      this.store.edit(
        (c) =>
          edit.updatePlacement(c, mockupId, item.id, {
            x: round((box.cx - box.w / 2) / content.w, 5),
            y: round((box.cy - box.h / 2) / content.h, 5),
            width: round(box.w / content.w, 5),
            height: round(box.h / content.h, 5),
            rotation: box.rot ? box.rot : undefined,
          }),
        key,
      );
      return;
    }
    this.store.edit(
      (c) =>
        edit.updateLayer(c, item.id, {
          x: Math.round(box.cx - box.w / 2),
          y: Math.round(box.cy - box.h / 2),
          width: Math.max(1, Math.round(box.w)),
          height: Math.max(1, Math.round(box.h)),
          rotation: box.rot ? box.rot : undefined,
        }),
      key,
    );
  }

  private applyQuad(item: StageItem, quad: Pt[]): void {
    const content = this.content();
    const mockupId = this.store.mockup()?.id;
    if (!content || !mockupId) return;
    const corners = quad.map((p) => [
      round(p.x / content.w, 5),
      round(p.y / content.h, 5),
    ]) as unknown as Corners;
    this.store.edit(
      (c) => edit.updatePlacement(c, mockupId, item.id, quadPatch(corners)),
      `corner:${item.id}`,
    );
  }

  private finishDraw(drag: Extract<Drag, { kind: 'draw' }>): void {
    this.drawing.set(null);
    const content = this.content();
    if (!content) return;
    const x = Math.min(drag.from.x, drag.to.x);
    const y = Math.min(drag.from.y, drag.to.y);
    const w = Math.abs(drag.to.x - drag.from.x);
    const h = Math.abs(drag.to.y - drag.from.y);
    this.store.tool.set({ kind: 'select' });
    if (w < 12 || h < 12) return;
    const shape: ShapeSpec = drag.shape === 'ellipse' ? { type: 'ellipse' } : { type: 'rect' };
    this.store.addAreaOnMockup(
      shape,
      {
        x: round(x / content.w, 5),
        y: round(y / content.h, 5),
        width: round(w / content.w, 5),
        height: round(h / content.h, 5),
      },
      content,
    );
  }
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Bounding box + corners patch for a perspective placement. */
function quadPatch(corners: Corners): Partial<AreaPlacement> {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    corners,
  };
}
