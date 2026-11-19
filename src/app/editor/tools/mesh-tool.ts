import { computed } from '@angular/core';
import type { AreaPlacement, MeshSpec } from '../../customizer/models/product.models';
import {
  Frame,
  clampMeshCells,
  meshFolds,
  meshFromSurface,
  meshLocal,
  placementFrame,
  resampleMesh,
} from '../../customizer/util/surface';
import { Pt } from '../util/box-math';
import { moveChecked } from '../util/mesh-edit';
import { HIT_RADIUS, PointerResult, ToolHost, toScreen } from './tool-host';

export const DEFAULT_MESH_CELLS = 5;

/** How many sample points make up each drawn grid line (a smooth curve through a row or column). */
const LINE_SAMPLES = 24;

/**
 * The Edit Mesh tool. The mesh is a cols x rows grid of control points in the placement's own frame;
 * the artwork is stretched over a smooth surface through them. Dragging a point re-renders the
 * preview live; a move that would fold the surface over itself is refused (and said so), so a saved
 * mesh is always valid.
 */
export class MeshTool {
  /** The picked control point; shared with the inspector through the store. */
  get selected() {
    return this.store.meshPoint;
  }

  private dragging: number | null = null;

  constructor(private readonly host: ToolHost) {}

  private get store() {
    return this.host.store;
  }

  private get areaId(): string | null {
    const t = this.store.tool();
    return t.kind === 'mesh' ? t.areaId : null;
  }

  readonly placement = computed<AreaPlacement | null>(() => {
    const id = this.areaId;
    return id ? this.store.placementFor(id) : null;
  });

  readonly mesh = computed<MeshSpec | null>(() => this.placement()?.mesh ?? null);

  private frame(): Frame | null {
    const p = this.placement();
    const c = this.host.content();
    const area = this.store.config()?.printableAreas.find((a) => a.id === p?.printableAreaId);
    if (!p || !c || !area) return null;
    return placementFrame(p, c.w, c.h, area.canvas.width / area.canvas.height);
  }

  /** The aspect the cylinder maths needs when a mesh is sampled from a curved surface. */
  private aspect(): number {
    return this.frame()?.aspect ?? 1;
  }

  /** Make sure the placement has a mesh (sampled from its current surface) when the tool opens. */
  begin(): void {
    const id = this.areaId;
    const p = this.placement();
    this.selected.set(null);
    this.dragging = null;
    if (!id || !p || p.mesh) return;
    this.store.patchPlacement(id, {
      mesh: meshFromSurface(p.surface, this.aspect(), DEFAULT_MESH_CELLS, DEFAULT_MESH_CELLS),
    });
    this.store.breakCoalescing();
  }

  // ---- overlay model -----------------------------------------------------------------------------------

  private toContent(local: readonly [number, number], frame: Frame): Pt {
    const [x, y] = frame.toPixels(local[0], local[1]);
    return { x, y };
  }

  /** Control points on screen. */
  readonly points = computed(() => {
    const mesh = this.mesh();
    const frame = this.frame();
    if (!mesh || !frame) return [];
    const t = this.host.transform();
    const sel = this.selected();
    const out: {
      x: number;
      y: number;
      index: number;
      selected: boolean;
      col: number;
      row: number;
    }[] = [];
    for (let j = 0; j < mesh.rows; j++) {
      for (let i = 0; i < mesh.cols; i++) {
        const index = j * mesh.cols + i;
        const s = toScreen(
          this.toContent([mesh.points[index * 2], mesh.points[index * 2 + 1]], frame),
          t,
        );
        out.push({ ...s, index, selected: sel === index, col: i, row: j });
      }
    }
    return out;
  });

  /** SVG path data of the grid: one smooth curve per row and per column. */
  readonly grid = computed(() => {
    const mesh = this.mesh();
    const frame = this.frame();
    if (!mesh || !frame) return '';
    const t = this.host.transform();
    const at = (u: number, v: number) => {
      const s = toScreen(this.toContent(meshLocal(mesh, u, v), frame), t);
      return `${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    };
    const parts: string[] = [];
    for (let j = 0; j < mesh.rows; j++) {
      const v = j / (mesh.rows - 1);
      parts.push(
        'M' + Array.from({ length: LINE_SAMPLES + 1 }, (_, k) => at(k / LINE_SAMPLES, v)).join('L'),
      );
    }
    for (let i = 0; i < mesh.cols; i++) {
      const u = i / (mesh.cols - 1);
      parts.push(
        'M' + Array.from({ length: LINE_SAMPLES + 1 }, (_, k) => at(u, k / LINE_SAMPLES)).join('L'),
      );
    }
    return parts.join('');
  });

  readonly folded = computed(() => {
    const m = this.mesh();
    return m ? meshFolds(m, this.aspect()).length : 0;
  });

  // ---- pointer -----------------------------------------------------------------------------------------

  down(content: Pt, screen: Pt): PointerResult {
    void content;
    let best = -1;
    let bestD = HIT_RADIUS + 2;
    for (const p of this.points()) {
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d <= bestD) {
        best = p.index;
        bestD = d;
      }
    }
    if (best < 0) return { handled: false };
    this.selected.set(best);
    this.dragging = best;
    this.store.interacting.set(true);
    this.store.toolNotice.set(null);
    return { handled: true };
  }

  move(content: Pt): void {
    if (this.dragging === null) return;
    const frame = this.frame();
    if (!frame) return;
    const local = frame.fromPixels(content.x, content.y);
    if (local) this.setPoint(this.dragging, local[0], local[1], `mesh:${this.dragging}`);
  }

  up(): void {
    this.dragging = null;
    this.store.interacting.set(false);
    this.store.breakCoalescing();
  }

  // ---- editing -----------------------------------------------------------------------------------------

  /** Move one control point to frame-local `(x, y)` unless that folds the surface. */
  setPoint(index: number, x: number, y: number, coalesce?: string): boolean {
    const id = this.areaId;
    const mesh = this.mesh();
    if (!id || !mesh) return false;
    const next = moveChecked(mesh, index, x, y, this.aspect());
    if (!next) {
      this.store.toolNotice.set('fold');
      return false;
    }
    this.store.toolNotice.set(null);
    this.store.patchPlacement(id, { mesh: next }, coalesce);
    return true;
  }

  key(event: KeyboardEvent): boolean {
    const mesh = this.mesh();
    if (event.key === 'Escape' || event.key === 'Enter') {
      this.exit();
      return true;
    }
    if (!mesh) return false;
    const count = mesh.cols * mesh.rows;
    const sel = this.selected();
    if (event.key === ']' || event.key === '[') {
      const step = event.key === ']' ? 1 : -1;
      this.selected.set(sel === null ? (step > 0 ? 0 : count - 1) : (sel + step + count) % count);
      return true;
    }
    if (sel === null) return false;
    const c = this.host.content();
    const frame = this.frame();
    const p = this.placement();
    if (!c || !frame || !p) return false;
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (!d) return false;
    // One content pixel in frame units (the frame may be rotated, so nudge along screen axes).
    const [px, py] = frame.toPixels(mesh.points[sel * 2], mesh.points[sel * 2 + 1]);
    const local = frame.fromPixels(px + d[0], py + d[1]);
    if (local) this.setPoint(sel, local[0], local[1], `mesh-key:${sel}`);
    return true;
  }

  /** Change the number of control points per row / column, keeping the surface's shape. */
  setDensity(cols: number, rows: number): void {
    const id = this.areaId;
    const mesh = this.mesh();
    if (!id || !mesh) return;
    const next = resampleMesh(mesh, clampMeshCells(cols), clampMeshCells(rows));
    this.selected.set(null);
    this.store.patchPlacement(id, { mesh: next });
    this.store.breakCoalescing();
  }

  /** Discard the mesh: the placement goes back to its rectangle / quad / cylinder. */
  reset(): void {
    const id = this.areaId;
    if (!id) return;
    this.selected.set(null);
    this.store.patchPlacement(id, { mesh: undefined });
    this.exit();
  }

  /** Re-sample the mesh from the placement's base surface (undoes manual point edits). */
  resetPoints(): void {
    const id = this.areaId;
    const p = this.placement();
    const mesh = this.mesh();
    if (!id || !p || !mesh) return;
    this.store.patchPlacement(id, {
      mesh: meshFromSurface(p.surface, this.aspect(), mesh.cols, mesh.rows),
    });
    this.store.breakCoalescing();
  }

  exit(): void {
    this.selected.set(null);
    this.store.tool.set({ kind: 'select' });
  }
}
