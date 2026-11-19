import { computed, signal } from '@angular/core';
import type { BezierAnchor, BezierPath } from '../../customizer/models/product.models';
import { BEZIER_LIMITS } from '../../customizer/models/product.models';
import {
  bezierBounds,
  contourSelfIntersects,
  pointInBezierPath,
} from '../../customizer/util/bezier';
import { Pt } from '../util/box-math';
import {
  AnchorRef,
  anchorAt,
  appendContour,
  asHole,
  canAddAnchor,
  cornerAnchor,
  dragAnchor,
  insertAnchor,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  pathFromAnchors,
  removeAnchor,
  scalePath,
  svgData,
  toggleSmooth,
  translatePath,
} from '../util/bezier-edit';
import { HIT_RADIUS, PointerResult, ToolHost, toScreen } from './tool-host';

type Drag =
  | { kind: 'new-anchor'; start: Pt }
  | { kind: 'anchor'; ref: AnchorRef }
  | { kind: 'handle'; ref: AnchorRef; which: 'in' | 'out' }
  | { kind: 'path'; last: Pt };

/** A drag shorter than this (screen pixels) while placing an anchor is a click, not a handle pull. */
const CLICK_SLOP = 3;

export interface PenAnchorView {
  x: number;
  y: number;
  selected: boolean;
  smooth: boolean;
  first: boolean;
  ref: AnchorRef;
}

export interface PenHandleView {
  /** Anchor and handle positions on screen. */
  ax: number;
  ay: number;
  hx: number;
  hy: number;
  which: 'in' | 'out';
}

/**
 * The Pen / Bezier tool. It has two jobs: building a new closed contour by clicking (click =
 * corner, click-drag = smooth anchor with mirrored handles, click the first anchor or press Enter
 * to close, Esc to cancel, Backspace to take the last anchor back), and editing the boundary of a
 * printable area (drag anchors and handles, click a segment to insert an anchor, double-click an anchor
 * to switch corner / smooth, Delete to remove it, drag inside to move the whole path).
 *
 * Geometry is stored as fractions of the photo, so it does not depend on the editor's zoom.
 */
export class PenTool {
  /** The contour being built (photo fractions), or null when editing an existing boundary. */
  readonly building = signal<{ anchors: BezierAnchor[]; cursor: Pt | null } | null>(null);
  private drag: Drag | null = null;

  constructor(private readonly host: ToolHost) {}

  private get store() {
    return this.host.store;
  }

  private get tool() {
    const t = this.store.tool();
    return t.kind === 'pen' ? t : null;
  }

  /** The boundary path being edited (the stored one). */
  readonly path = computed<BezierPath | null>(() => {
    const t = this.tool;
    if (!t || t.mode === 'new-area' || !t.areaId) return null;
    const mask = this.store.placementFor(t.areaId)?.mask;
    return mask?.type === 'path' ? mask.path : null;
  });

  /** Start (or restart) a drawing session. */
  begin(): void {
    this.drag = null;
    const t = this.tool;
    this.building.set(t && t.mode !== 'edit' ? { anchors: [], cursor: null } : null);
    this.store.penAnchor.set(null);
  }

  // ---- overlay model -------------------------------------------------------------------------------

  /** The outline as SVG path data in screen space. */
  readonly outline = computed(() => {
    const t = this.host.transform();
    const c = this.host.content();
    if (!c) return '';
    const map = (x: number, y: number): [number, number] => [
      x * c.w * t.scale + t.tx,
      y * c.h * t.scale + t.ty,
    ];
    const b = this.building();
    if (b) {
      // The open contour so far plus a rubber band to the pointer.
      if (b.anchors.length === 0) return '';
      const open: BezierPath = {
        version: 1,
        fillRule: 'nonzero',
        contours: [{ anchors: b.anchors }],
      };
      let d = svgData(open, map).replace(/Z$/, '');
      if (b.cursor && b.anchors.length > 0) {
        const last = b.anchors[b.anchors.length - 1];
        const to = map(b.cursor.x, b.cursor.y);
        if (last.handleOut) {
          const h = map(last.handleOut[0], last.handleOut[1]);
          d += `M${map(last.x, last.y)[0].toFixed(2)} ${map(last.x, last.y)[1].toFixed(2)}C${h[0].toFixed(2)} ${h[1].toFixed(2)} ${to[0].toFixed(2)} ${to[1].toFixed(2)} ${to[0].toFixed(2)} ${to[1].toFixed(2)}`;
        } else {
          const from = map(last.x, last.y);
          d += `M${from[0].toFixed(2)} ${from[1].toFixed(2)}L${to[0].toFixed(2)} ${to[1].toFixed(2)}`;
        }
      }
      return d;
    }
    const p = this.path();
    return p ? svgData(p, map) : '';
  });

  readonly anchors = computed<PenAnchorView[]>(() => {
    const c = this.host.content();
    if (!c) return [];
    const t = this.host.transform();
    const screen = (x: number, y: number) => toScreen({ x: x * c.w, y: y * c.h }, t);
    const b = this.building();
    if (b) {
      return b.anchors.map((a, i) => ({
        ...screen(a.x, a.y),
        selected: i === b.anchors.length - 1,
        smooth: !!a.smooth,
        first: i === 0,
        ref: { contour: 0, anchor: i },
      }));
    }
    const p = this.path();
    const sel = this.store.penAnchor();
    if (!p) return [];
    return p.contours.flatMap((contour, ci) =>
      contour.anchors.map((a, ai) => ({
        ...screen(a.x, a.y),
        selected: !!sel && sel.contour === ci && sel.anchor === ai,
        smooth: !!a.smooth,
        first: false,
        ref: { contour: ci, anchor: ai },
      })),
    );
  });

  /** Handles of the selected anchor and, while building, of the newest one. */
  readonly handles = computed<PenHandleView[]>(() => {
    const c = this.host.content();
    if (!c) return [];
    const t = this.host.transform();
    const screen = (x: number, y: number) => toScreen({ x: x * c.w, y: y * c.h }, t);
    const out: PenHandleView[] = [];
    const add = (a: BezierAnchor | null) => {
      if (!a) return;
      const p = screen(a.x, a.y);
      for (const which of ['in', 'out'] as const) {
        const h = which === 'in' ? a.handleIn : a.handleOut;
        if (!h) continue;
        const s = screen(h[0], h[1]);
        out.push({ ax: p.x, ay: p.y, hx: s.x, hy: s.y, which });
      }
    };
    const b = this.building();
    if (b) {
      add(b.anchors[b.anchors.length - 1] ?? null);
      return out;
    }
    const p = this.path();
    const sel = this.store.penAnchor();
    if (p && sel) add(anchorAt(p, sel));
    return out;
  });

  /** On-screen position of the first anchor while building (where a click closes the contour). */
  readonly closeTarget = computed(() => {
    const b = this.building();
    const c = this.host.content();
    if (!b || !c || b.anchors.length < BEZIER_LIMITS.minAnchorsPerContour) return null;
    return toScreen({ x: b.anchors[0].x * c.w, y: b.anchors[0].y * c.h }, this.host.transform());
  });

  readonly crossing = computed(() => {
    const p = this.path();
    return !!p && p.contours.some((contour) => contourSelfIntersects(contour));
  });

  // ---- pointer -----------------------------------------------------------------------------------------

  private norm(content: Pt): Pt {
    const c = this.host.content()!;
    return { x: content.x / c.w, y: content.y / c.h };
  }

  down(content: Pt, screen: Pt, event: PointerEvent): PointerResult {
    const c = this.host.content();
    if (!c) return { handled: false };
    const n = this.norm(content);
    const b = this.building();
    if (b) {
      // Click the first anchor to close.
      const close = this.closeTarget();
      if (close && Math.hypot(close.x - screen.x, close.y - screen.y) <= HIT_RADIUS + 2) {
        this.finish();
        return { handled: true };
      }
      if (!canAddAnchor(this.currentPath(), b.anchors.length)) {
        this.store.toolNotice.set('limit');
        return { handled: true };
      }
      this.building.set({ anchors: [...b.anchors, cornerAnchor(n.x, n.y)], cursor: n });
      this.drag = { kind: 'new-anchor', start: screen };
      this.store.interacting.set(true);
      return { handled: true };
    }
    return this.pressEditing(content, screen, event);
  }

  private currentPath(): BezierPath | null {
    return this.path();
  }

  private pressEditing(content: Pt, screen: Pt, event: PointerEvent): PointerResult {
    const path = this.path();
    const tool = this.tool;
    const c = this.host.content();
    if (!path || !tool?.areaId || !c) return { handled: false };
    const t = this.host.transform();
    const near = (x: number, y: number) =>
      Math.hypot(x * c.w * t.scale + t.tx - screen.x, y * c.h * t.scale + t.ty - screen.y) <=
      HIT_RADIUS;

    // 1. The selected anchor's handles.
    const sel = this.store.penAnchor();
    const selected = sel ? anchorAt(path, sel) : null;
    if (sel && selected) {
      for (const which of ['in', 'out'] as const) {
        const h = which === 'in' ? selected.handleIn : selected.handleOut;
        if (h && near(h[0], h[1])) {
          this.drag = { kind: 'handle', ref: sel, which };
          this.store.interacting.set(true);
          return { handled: true };
        }
      }
    }
    // 2. Anchors (Alt + click removes).
    for (let ci = path.contours.length - 1; ci >= 0; ci--) {
      const anchors = path.contours[ci].anchors;
      for (let ai = anchors.length - 1; ai >= 0; ai--) {
        if (!near(anchors[ai].x, anchors[ai].y)) continue;
        const ref = { contour: ci, anchor: ai };
        if (event.altKey) {
          this.removeSelected(ref);
          return { handled: true };
        }
        this.store.penAnchor.set(ref);
        this.drag = { kind: 'anchor', ref };
        this.store.interacting.set(true);
        return { handled: true };
      }
    }
    // 3. A segment: insert an anchor there and carry on dragging it.
    const pixelPath = scalePath(path, c.w, c.h);
    const hit = nearestOnPath(pixelPath, [content.x, content.y], HIT_RADIUS / t.scale);
    if (hit) {
      const next = insertAnchor(path, hit.contour, hit.segment, hit.t);
      if (next !== path) {
        this.commit(next, 'pen:insert');
        const ref = { contour: hit.contour, anchor: hit.segment + 1 };
        this.store.penAnchor.set(ref);
        this.drag = { kind: 'anchor', ref };
        this.store.interacting.set(true);
        return { handled: true };
      }
    }
    // 4. Inside the boundary: move the whole path.
    if (pointInBezierPath(path, [content.x / c.w, content.y / c.h])) {
      this.store.penAnchor.set(null);
      this.drag = { kind: 'path', last: content };
      this.store.interacting.set(true);
      return { handled: true };
    }
    this.store.penAnchor.set(null);
    return { handled: false };
  }

  move(content: Pt, screen: Pt, event: PointerEvent): void {
    const c = this.host.content();
    if (!c) return;
    const n = this.norm(content);
    const b = this.building();
    if (b) {
      if (this.drag?.kind === 'new-anchor' && b.anchors.length > 0) {
        const start = this.drag.start;
        const last = b.anchors[b.anchors.length - 1];
        const moved = Math.hypot(screen.x - start.x, screen.y - start.y) > CLICK_SLOP;
        const anchors = b.anchors.slice(0, -1);
        anchors.push(moved ? dragAnchor(last.x, last.y, n.x, n.y) : cornerAnchor(last.x, last.y));
        this.building.set({ anchors, cursor: n });
      } else {
        this.building.set({ ...b, cursor: n });
      }
      return;
    }
    const drag = this.drag;
    const path = this.path();
    if (!drag || !path) return;
    switch (drag.kind) {
      case 'anchor':
        this.commit(
          moveAnchor(path, drag.ref, n.x, n.y),
          `pen:${drag.ref.contour}:${drag.ref.anchor}`,
        );
        break;
      case 'handle':
        this.commit(
          moveHandle(path, drag.ref, drag.which, n.x, n.y, event.altKey),
          `pen:${drag.ref.contour}:${drag.ref.anchor}:${drag.which}`,
        );
        this.drag = drag;
        break;
      case 'path': {
        this.commit(
          translatePath(path, (content.x - drag.last.x) / c.w, (content.y - drag.last.y) / c.h),
          'pen:move',
        );
        this.drag = { kind: 'path', last: content };
        break;
      }
    }
  }

  up(): void {
    this.drag = null;
    this.store.interacting.set(false);
    this.store.breakCoalescing();
  }

  doubleClick(content: Pt, screen: Pt): boolean {
    const path = this.path();
    const c = this.host.content();
    if (!path || !c || this.building()) return false;
    const t = this.host.transform();
    for (let ci = 0; ci < path.contours.length; ci++) {
      for (let ai = 0; ai < path.contours[ci].anchors.length; ai++) {
        const a = path.contours[ci].anchors[ai];
        if (
          Math.hypot(
            a.x * c.w * t.scale + t.tx - screen.x,
            a.y * c.h * t.scale + t.ty - screen.y,
          ) <= HIT_RADIUS
        ) {
          this.store.penAnchor.set({ contour: ci, anchor: ai });
          this.commit(toggleSmooth(path, { contour: ci, anchor: ai }), 'pen:smooth');
          this.store.breakCoalescing();
          return true;
        }
      }
    }
    void content;
    return false;
  }

  // ---- keyboard ----------------------------------------------------------------------------------------

  /** Returns true when the key was used. */
  key(event: KeyboardEvent): boolean {
    const b = this.building();
    if (b) {
      if (event.key === 'Escape') {
        this.cancel();
        return true;
      }
      if (event.key === 'Enter') {
        this.finish();
        return true;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        this.building.set({ ...b, anchors: b.anchors.slice(0, -1) });
        return true;
      }
      return false;
    }
    if (event.key === 'Escape' || event.key === 'Enter') {
      this.exit();
      return true;
    }
    const sel = this.store.penAnchor();
    const path = this.path();
    if (path && (event.key === '[' || event.key === ']')) {
      // Walk through the points without the pointer: previous / next anchor, across contours.
      const all = path.contours.flatMap((c, ci) =>
        c.anchors.map((_, ai) => ({ contour: ci, anchor: ai })),
      );
      const at = sel
        ? all.findIndex((r) => r.contour === sel.contour && r.anchor === sel.anchor)
        : -1;
      const step = event.key === ']' ? 1 : -1;
      this.store.penAnchor.set(
        all[at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length],
      );
      return true;
    }
    if (!sel || !path) return false;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.removeSelected(sel);
      return true;
    }
    const c = this.host.content();
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    const a = anchorAt(path, sel);
    if (d && a && c) {
      this.commit(
        moveAnchor(path, sel, a.x + d[0] / c.w, a.y + d[1] / c.h),
        `pen:key:${sel.contour}:${sel.anchor}`,
      );
      return true;
    }
    return false;
  }

  // ---- actions -----------------------------------------------------------------------------------------

  /** Close the contour being built and commit it (needs at least three anchors). */
  finish(): void {
    const b = this.building();
    const tool = this.tool;
    const c = this.host.content();
    if (!b || !tool || !c) return;
    if (b.anchors.length < BEZIER_LIMITS.minAnchorsPerContour) {
      this.store.toolNotice.set('too-few');
      return;
    }
    const anchors = b.anchors;
    this.building.set(null);
    this.drag = null;
    this.store.interacting.set(false);
    if (tool.mode === 'new-area') {
      const path = pathFromAnchors(anchors);
      const bounds = bezierBounds(path);
      if (!bounds || bounds.width * c.w < 12 || bounds.height * c.h < 12) {
        this.store.toolNotice.set('too-small');
        this.store.tool.set({ kind: 'select' });
        return;
      }
      this.store.tool.set({ kind: 'select' });
      const id = this.store.addAreaOnMockup(
        { type: 'rect' },
        { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        c,
        { mask: { type: 'path', path } },
      );
      if (id) this.store.tool.set({ kind: 'pen', mode: 'edit', areaId: id });
      return;
    }
    if (tool.mode === 'new-contour' && tool.areaId) {
      const existing = this.store.placementFor(tool.areaId)?.mask;
      // With an outline already there the new contour is a hole in it; otherwise it becomes the outline.
      const next =
        existing?.type === 'path'
          ? appendContour(existing.path, asHole(existing.path, anchors))
          : pathFromAnchors(anchors);
      this.store.patchPlacement(tool.areaId, { mask: { type: 'path', path: next } });
      this.store.penAnchor.set(null);
      this.store.tool.set({ kind: 'pen', mode: 'edit', areaId: tool.areaId });
    }
  }

  /** Throw away the contour being built. */
  cancel(): void {
    const tool = this.tool;
    this.building.set(null);
    this.drag = null;
    this.store.interacting.set(false);
    if (tool?.mode === 'new-contour' && tool.areaId) {
      this.store.tool.set({ kind: 'pen', mode: 'edit', areaId: tool.areaId });
    } else {
      this.store.tool.set({ kind: 'select' });
    }
  }

  exit(): void {
    this.store.penAnchor.set(null);
    this.store.tool.set({ kind: 'select' });
  }

  removeSelected(ref: AnchorRef): void {
    const tool = this.tool;
    const path = this.path();
    if (!path || !tool?.areaId) return;
    const next = removeAnchor(path, ref);
    this.store.penAnchor.set(null);
    if (!next) {
      this.store.patchPlacement(tool.areaId, { mask: undefined });
      this.exit();
      return;
    }
    this.commit(next, undefined);
    this.store.breakCoalescing();
  }

  private commit(path: BezierPath, coalesce: string | undefined): void {
    const tool = this.tool;
    if (!tool?.areaId) return;
    this.store.patchPlacement(tool.areaId, { mask: { type: 'path', path } }, coalesce);
  }
}
