import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { Component, computed, inject, input } from '@angular/core';
import type { MessageKey } from '../../admin/i18n/messages.en';
import { AreaPlacement } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';

const BLEND: { value: string; label: MessageKey }[] = [
  { value: 'normal', label: 'inspector.blend.normal' },
  { value: 'multiply', label: 'inspector.blend.multiply' },
  { value: 'overlay', label: 'inspector.blend.overlay' },
  { value: 'soft-light', label: 'inspector.blend.soft-light' },
];

/**
 * Where one printable area sits on one mockup. Values are shown in pixels of the product photo but
 * stored as fractions of it, so resizing the editor or the browser never changes them.
 */
@Component({
  selector: 'app-placement-fields',
  imports: [CONTROLS, TranslatePipe],
  template: `
    @if (size(); as s) {
      <div class="grid-2">
        <app-num
          [label]="'inspector.placement.x' | t"
          [value]="round(placement().x * s.w)"
          (changed)="patch({ x: $event / s.w })"
        />
        <app-num
          [label]="'inspector.placement.y' | t"
          [value]="round(placement().y * s.h)"
          (changed)="patch({ y: $event / s.h })"
        />
        <app-num
          [label]="'inspector.width' | t"
          [value]="round(placement().width * s.w)"
          [min]="4"
          (changed)="patch({ width: $event / s.w })"
        />
        <app-num
          [label]="'inspector.height' | t"
          [value]="round(placement().height * s.h)"
          [min]="4"
          (changed)="patch({ height: $event / s.h })"
        />
        <app-num
          [label]="'inspector.placement.rotation' | t"
          [value]="placement().rotation ?? 0"
          [min]="-360"
          [max]="360"
          step="0.5"
          [disabled]="placement().type === 'quad'"
          (changed)="patch({ rotation: $event || undefined })"
        />
        <app-num
          [label]="'inspector.opacity' | t"
          [value]="round((placement().opacity ?? 1) * 100)"
          [min]="0"
          [max]="100"
          (changed)="patch({ opacity: $event >= 100 ? undefined : $event / 100 })"
        />
      </div>
      <app-select
        [label]="'inspector.placement.blend' | t"
        [options]="blend()"
        [value]="placement().blendMode ?? 'normal'"
        (changed)="setBlend($event)"
      />
      <div class="row">
        <app-check
          [label]="'inspector.placement.perspective' | t"
          [value]="placement().type === 'quad'"
          (changed)="togglePerspective($event)"
        />
      </div>
      <button type="button" class="btn btn--sm" (click)="matchAspect()">
        {{ 'inspector.placement.match' | t }}
      </button>
    } @else {
      <p class="field-hint">{{ 'inspector.placement.loading' | t }}</p>
    }
  `,
})
export class PlacementFieldsComponent {
  private readonly store = inject(EditorStore);
  private readonly i18n = inject(I18n);
  protected readonly blend = computed<Option[]>(() =>
    BLEND.map((b) => ({ value: b.value, label: this.i18n.t(b.label) })),
  );

  readonly mockupId = input.required<string>();
  readonly placement = input.required<AreaPlacement>();

  protected readonly size = computed(() => this.store.mockupSize(this.mockupId()));

  protected round(n: number): number {
    return Math.round(n);
  }

  protected patch(patch: Partial<AreaPlacement>): void {
    const areaId = this.placement().printableAreaId;
    this.store.edit(
      (c) => edit.updatePlacement(c, this.mockupId(), areaId, patch),
      `placement:${areaId}:${Object.keys(patch)[0]}`,
    );
  }

  protected setBlend(value: string): void {
    const blendMode =
      value !== 'normal' && BLEND.some((b) => b.value === value)
        ? (value as AreaPlacement['blendMode'])
        : undefined;
    this.patch({ blendMode });
  }

  protected togglePerspective(on: boolean): void {
    const p = this.placement();
    if (on) {
      const x1 = p.x + p.width;
      const y1 = p.y + p.height;
      this.patch({
        type: 'quad',
        rotation: undefined,
        corners: [
          [p.x, p.y],
          [x1, p.y],
          [x1, y1],
          [p.x, y1],
        ],
      });
    } else {
      this.patch({ type: 'rect', corners: undefined });
    }
  }

  /** Resize about the centre so the pixel proportions equal the area's production canvas. */
  protected matchAspect(): void {
    const p = this.placement();
    const s = this.size();
    const area = this.store.config()?.printableAreas.find((a) => a.id === p.printableAreaId);
    if (!s || !area) return;
    const aspect = area.canvas.width / area.canvas.height;
    const heightFraction = (p.width * s.w) / aspect / s.h;
    this.patch({ height: heightFraction, y: p.y + p.height / 2 - heightFraction / 2 });
  }
}
