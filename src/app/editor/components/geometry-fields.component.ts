import { Component, computed, inject, input } from '@angular/core';
import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import type {
  AreaPlacement,
  BezierPath,
  PrintableArea,
} from '../../customizer/models/product.models';
import { MESH_LIMITS } from '../../customizer/models/product.models';
import { bezierBounds, bezierToSvgPath, contourSelfIntersects } from '../../customizer/util/bezier';
import {
  DEFAULT_CYLINDER,
  clampCylinder,
  meshFolds,
  meshFromSurface,
  resampleMesh,
} from '../../customizer/util/surface';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import { anchorAt, moveAnchor, setFillRule, toggleSmooth, totalAnchors } from '../util/bezier-edit';
import { frameAspect, moveChecked } from '../util/mesh-edit';
import { CONTROLS, Option } from './controls.component';

/**
 * Inspector controls for the geometry of one placement: the printable boundary on the photo (Pen /
 * Bezier outline or painted mask), the surface the artwork is bent onto (cylinder) and the editable
 * mesh. All of it is mockup-space geometry; none of it changes the flat production artwork.
 */
@Component({
  selector: 'app-geometry-fields',
  imports: [CONTROLS, SectionComponent, TranslatePipe],
  template: `
    <app-section [title]="'inspector.boundary.title' | t">
      <p class="field-hint">{{ 'inspector.boundary.hint' | t }}</p>
      <p class="field-hint" data-testid="boundary-summary">{{ boundarySummary() }}</p>

      <div class="row">
        @if (maskKind() === 'path') {
          <button type="button" class="btn btn--sm" (click)="editOutline()">
            {{ 'inspector.boundary.edit' | t }}
          </button>
          <button type="button" class="btn btn--sm" (click)="addHole()">
            {{ 'inspector.boundary.hole' | t }}
          </button>
        } @else {
          <button type="button" class="btn btn--sm" (click)="drawOutline()">
            {{ 'inspector.boundary.draw' | t }}
          </button>
        }
        <button type="button" class="btn btn--sm" (click)="paint()">
          {{
            (maskKind() === 'raster' ? 'inspector.boundary.paint-edit' : 'inspector.boundary.paint')
              | t
          }}
        </button>
        @if (maskKind()) {
          <button type="button" class="btn btn--sm btn--danger" (click)="removeBoundary()">
            {{ 'inspector.boundary.remove' | t }}
          </button>
        }
      </div>

      @if (path(); as p) {
        <app-select
          [label]="'inspector.boundary.fill-rule' | t"
          [options]="fillRules()"
          [value]="p.fillRule"
          (changed)="fillRule($event)"
        />
        @if (crossing()) {
          <p class="notice notice--warning" role="status">
            {{ 'inspector.boundary.crossing' | t: { rule: p.fillRule } }}
          </p>
        }
        @if (anchor(); as a) {
          <div
            class="stack stack--tight"
            role="group"
            [attr.aria-label]="'inspector.boundary.anchor' | t"
          >
            <div class="grid-2">
              <app-num
                [label]="'inspector.boundary.anchor-x' | t"
                [value]="a.px"
                step="0.5"
                (changed)="moveAnchorTo('x', $event)"
              />
              <app-num
                [label]="'inspector.boundary.anchor-y' | t"
                [value]="a.py"
                step="0.5"
                (changed)="moveAnchorTo('y', $event)"
              />
            </div>
            <app-check
              [label]="'inspector.boundary.smooth' | t"
              [value]="a.smooth"
              (changed)="setSmooth($event)"
            />
          </div>
        }
        <button type="button" class="btn btn--sm" (click)="useAsProductionShape()">
          {{ 'inspector.boundary.use-shape' | t }}
        </button>
        <p class="field-hint">{{ 'inspector.boundary.use-shape-hint' | t }}</p>
      }
    </app-section>

    <app-section [title]="'inspector.surface.title' | t">
      <p class="field-hint">{{ 'inspector.surface.hint' | t }}</p>
      <app-select
        [label]="'inspector.surface.type' | t"
        [options]="surfaceTypes()"
        [value]="surfaceType()"
        (changed)="setSurfaceType($event)"
      />

      @if (placement().surface; as s) {
        @if (placement().mesh) {
          <p class="field-hint">{{ 'inspector.surface.mesh-locks' | t }}</p>
        }
        <app-range
          [label]="'inspector.surface.curvature' | t"
          [value]="s.curvature"
          [min]="0"
          [max]="360"
          [disabled]="!!placement().mesh"
          (changed)="setCylinder({ curvature: $event })"
        />
        <app-range
          [label]="'inspector.surface.centre' | t"
          [value]="s.centre"
          [min]="-180"
          [max]="180"
          [disabled]="!!placement().mesh"
          (changed)="setCylinder({ centre: $event })"
        />
        <app-range
          [label]="'inspector.surface.visible-left' | t"
          [value]="s.visibleLeft"
          [min]="1"
          [max]="90"
          [disabled]="!!placement().mesh"
          (changed)="setCylinder({ visibleLeft: $event })"
        />
        <app-range
          [label]="'inspector.surface.visible-right' | t"
          [value]="s.visibleRight"
          [min]="1"
          [max]="90"
          [disabled]="!!placement().mesh"
          (changed)="setCylinder({ visibleRight: $event })"
        />
        <app-range
          [label]="'inspector.surface.tilt' | t"
          [value]="s.tilt"
          [min]="-60"
          [max]="60"
          [disabled]="!!placement().mesh"
          (changed)="setCylinder({ tilt: $event })"
        />
      }

      @if (placement().mesh; as m) {
        <div class="stack stack--tight" role="group" [attr.aria-label]="'inspector.mesh.title' | t">
          <div class="grid-2">
            <app-num
              [label]="'inspector.mesh.cols' | t"
              [value]="m.cols"
              [min]="meshLimits.minCells"
              [max]="meshLimits.maxCells"
              (changed)="density($event, m.rows)"
            />
            <app-num
              [label]="'inspector.mesh.rows' | t"
              [value]="m.rows"
              [min]="meshLimits.minCells"
              [max]="meshLimits.maxCells"
              (changed)="density(m.cols, $event)"
            />
          </div>
          @if (meshPoint(); as p) {
            <div class="grid-2">
              <app-num
                [label]="'inspector.mesh.x' | t"
                [value]="p.x"
                step="0.5"
                (changed)="movePoint('x', $event)"
              />
              <app-num
                [label]="'inspector.mesh.y' | t"
                [value]="p.y"
                step="0.5"
                (changed)="movePoint('y', $event)"
              />
            </div>
          } @else {
            <p class="field-hint">{{ 'inspector.mesh.none-selected' | t }}</p>
          }
          @if (meshFolded() > 0) {
            <p class="notice notice--warning" role="status">{{ 'inspector.mesh.folded' | t }}</p>
          }
          <div class="row">
            <button type="button" class="btn btn--sm" (click)="resetPoints()">
              {{ 'inspector.mesh.reset-points' | t }}
            </button>
            <button type="button" class="btn btn--sm" (click)="resetMesh()">
              {{ 'inspector.mesh.reset' | t }}
            </button>
          </div>
        </div>
      }

      <div class="row">
        <button type="button" class="btn btn--sm" (click)="editMesh()">
          {{ 'inspector.surface.edit-mesh' | t }}
        </button>
        @if (placement().surface || placement().mesh) {
          <button type="button" class="btn btn--sm" (click)="resetTransformation()">
            {{ 'inspector.surface.reset' | t }}
          </button>
        }
        @if (store.tool().kind === 'mesh') {
          <button type="button" class="btn btn--sm btn--primary" (click)="done()">
            {{ 'common.done' | t }}
          </button>
        }
      </div>
    </app-section>
  `,
})
export class GeometryFieldsComponent {
  protected readonly store = inject(EditorStore);
  private readonly i18n = inject(I18n);
  protected readonly meshLimits = MESH_LIMITS;

  readonly mockupId = input.required<string>();
  readonly placement = input.required<AreaPlacement>();

  private readonly area = computed<PrintableArea | null>(
    () =>
      this.store.config()?.printableAreas.find((a) => a.id === this.placement().printableAreaId) ??
      null,
  );
  private readonly size = computed(() => this.store.mockupSize(this.mockupId()));

  // ---- boundary ------------------------------------------------------------------------------------

  protected readonly maskKind = computed(() => this.placement().mask?.type ?? null);

  protected readonly path = computed<BezierPath | null>(() => {
    const m = this.placement().mask;
    return m?.type === 'path' ? m.path : null;
  });

  protected readonly crossing = computed(() => {
    const p = this.path();
    return !!p && p.contours.some((c) => contourSelfIntersects(c));
  });

  protected readonly boundarySummary = computed(() => {
    const m = this.placement().mask;
    if (!m) return this.i18n.t('inspector.boundary.none');
    if (m.type === 'path') {
      return this.i18n.t('inspector.boundary.path', {
        count: totalAnchors(m.path),
        contours: m.path.contours.length,
      });
    }
    return this.i18n.t('inspector.boundary.raster', { width: m.width, height: m.height });
  });

  protected readonly fillRules = computed<Option[]>(() => [
    { value: 'nonzero', label: this.i18n.t('inspector.boundary.rule.nonzero') },
    { value: 'evenodd', label: this.i18n.t('inspector.boundary.rule.evenodd') },
  ]);

  /** The selected outline point, in photo pixels. */
  protected readonly anchor = computed(() => {
    const p = this.path();
    const ref = this.store.penAnchor();
    const s = this.size();
    if (!p || !ref || !s) return null;
    const a = anchorAt(p, ref);
    return a
      ? {
          px: Math.round(a.x * s.w * 10) / 10,
          py: Math.round(a.y * s.h * 10) / 10,
          smooth: !!a.smooth,
        }
      : null;
  });

  private setMaskPath(path: BezierPath, coalesce?: string): void {
    this.store.patchPlacement(
      this.placement().printableAreaId,
      { mask: { type: 'path', path } },
      coalesce,
    );
  }

  private startTool(tool: Parameters<typeof this.store.tool.set>[0]): void {
    this.store.view.set('mockup');
    this.store.penAnchor.set(null);
    this.store.tool.set(tool);
  }

  protected drawOutline(): void {
    this.startTool({ kind: 'pen', mode: 'new-contour', areaId: this.placement().printableAreaId });
  }

  protected editOutline(): void {
    this.startTool({ kind: 'pen', mode: 'edit', areaId: this.placement().printableAreaId });
  }

  protected addHole(): void {
    this.startTool({ kind: 'pen', mode: 'new-contour', areaId: this.placement().printableAreaId });
  }

  protected paint(): void {
    this.startTool({ kind: 'brush', areaId: this.placement().printableAreaId });
  }

  protected removeBoundary(): void {
    this.store.tool.set({ kind: 'select' });
    this.store.patchPlacement(this.placement().printableAreaId, { mask: undefined });
  }

  protected fillRule(value: string): void {
    const p = this.path();
    if (p && (value === 'nonzero' || value === 'evenodd')) this.setMaskPath(setFillRule(p, value));
  }

  protected moveAnchorTo(axis: 'x' | 'y', value: number): void {
    const p = this.path();
    const ref = this.store.penAnchor();
    const s = this.size();
    const a = p && ref ? anchorAt(p, ref) : null;
    if (!p || !ref || !s || !a) return;
    const x = axis === 'x' ? value / s.w : a.x;
    const y = axis === 'y' ? value / s.h : a.y;
    this.setMaskPath(moveAnchor(p, ref, x, y), `anchor-num:${ref.contour}:${ref.anchor}:${axis}`);
  }

  protected setSmooth(on: boolean): void {
    const p = this.path();
    const ref = this.store.penAnchor();
    const a = p && ref ? anchorAt(p, ref) : null;
    if (p && ref && a && !!a.smooth !== on) this.setMaskPath(toggleSmooth(p, ref));
  }

  /**
   * Make the production artwork take the outline's shape (stickers, patches): the outline becomes the
   * area's shape, fitted to the outline's own bounds, and the placement is fitted to those bounds so
   * the two agree on the photo.
   */
  protected useAsProductionShape(): void {
    const p = this.path();
    const area = this.area();
    const bounds = p ? bezierBounds(p) : null;
    if (!p || !area || !bounds) return;
    const d = bezierToSvgPath(
      p,
      { x: bounds.x, y: bounds.y, width: bounds.width / 1000, height: bounds.height / 1000 },
      1,
    );
    this.store.edit((c) => ({
      ...c,
      printableAreas: c.printableAreas.map((a) =>
        a.id === area.id ? { ...a, shape: { type: 'path', d, viewBox: [1000, 1000] } } : a,
      ),
    }));
    this.store.patchPlacement(area.id, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      rotation: undefined,
    });
  }

  protected done(): void {
    this.store.penAnchor.set(null);
    this.store.tool.set({ kind: 'select' });
  }

  // ---- surface -------------------------------------------------------------------------------------

  protected readonly surfaceType = computed(() =>
    this.placement().mesh ? 'mesh' : this.placement().surface ? 'cylinder' : 'flat',
  );

  protected readonly surfaceTypes = computed<Option[]>(() => [
    { value: 'flat', label: this.i18n.t('inspector.surface.flat') },
    { value: 'cylinder', label: this.i18n.t('inspector.surface.cylinder') },
    { value: 'mesh', label: this.i18n.t('inspector.surface.mesh') },
  ]);

  protected setSurfaceType(value: string): void {
    const id = this.placement().printableAreaId;
    if (value === 'flat') this.store.patchPlacement(id, { surface: undefined, mesh: undefined });
    else if (value === 'cylinder') {
      this.store.patchPlacement(id, {
        surface: this.placement().surface ?? { ...DEFAULT_CYLINDER },
        mesh: undefined,
      });
    } else if (value === 'mesh') this.editMesh();
  }

  protected setCylinder(patch: Partial<NonNullable<AreaPlacement['surface']>>): void {
    const s = this.placement().surface;
    if (!s) return;
    this.store.patchPlacement(
      this.placement().printableAreaId,
      { surface: clampCylinder({ ...s, ...patch }) },
      `surface:${Object.keys(patch)[0]}`,
    );
  }

  protected resetTransformation(): void {
    this.store.tool.set({ kind: 'select' });
    this.store.patchPlacement(this.placement().printableAreaId, {
      surface: undefined,
      mesh: undefined,
    });
  }

  // ---- mesh ----------------------------------------------------------------------------------------

  private aspect(): number {
    const s = this.size();
    const a = this.area();
    return s && a ? frameAspect(this.placement(), s, a.canvas.width / a.canvas.height) : 1;
  }

  protected editMesh(): void {
    this.store.view.set('mockup');
    this.store.meshPoint.set(null);
    this.store.tool.set({ kind: 'mesh', areaId: this.placement().printableAreaId });
  }

  protected readonly meshPoint = computed(() => {
    const m = this.placement().mesh;
    const i = this.store.meshPoint();
    if (!m || i === null || i >= m.cols * m.rows) return null;
    return {
      x: Math.round(m.points[i * 2] * 1000) / 10,
      y: Math.round(m.points[i * 2 + 1] * 1000) / 10,
    };
  });

  protected readonly meshFolded = computed(() => {
    const m = this.placement().mesh;
    return m ? meshFolds(m, this.aspect()).length : 0;
  });

  protected movePoint(axis: 'x' | 'y', percent: number): void {
    const m = this.placement().mesh;
    const i = this.store.meshPoint();
    if (!m || i === null) return;
    const x = axis === 'x' ? percent / 100 : m.points[i * 2];
    const y = axis === 'y' ? percent / 100 : m.points[i * 2 + 1];
    const next = moveChecked(m, i, x, y, this.aspect());
    if (!next) {
      this.store.toolNotice.set('fold');
      return;
    }
    this.store.toolNotice.set(null);
    this.store.patchPlacement(
      this.placement().printableAreaId,
      { mesh: next },
      `mesh-num:${i}:${axis}`,
    );
  }

  protected density(cols: number, rows: number): void {
    const m = this.placement().mesh;
    if (!m) return;
    this.store.meshPoint.set(null);
    this.store.patchPlacement(
      this.placement().printableAreaId,
      { mesh: resampleMesh(m, cols, rows) },
      'mesh-density',
    );
  }

  protected resetPoints(): void {
    const p = this.placement();
    const m = p.mesh;
    if (!m) return;
    this.store.patchPlacement(p.printableAreaId, {
      mesh: meshFromSurface(p.surface, this.aspect(), m.cols, m.rows),
    });
  }

  protected resetMesh(): void {
    this.store.meshPoint.set(null);
    if (this.store.tool().kind === 'mesh') this.store.tool.set({ kind: 'select' });
    this.store.patchPlacement(this.placement().printableAreaId, { mesh: undefined });
  }
}
