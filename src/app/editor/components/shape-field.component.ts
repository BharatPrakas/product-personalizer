import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ShapeSpec } from '../../customizer/models/product.models';
import { HEART_SHAPE, isSafePathData, parseSvgMask } from '../../customizer/util/geometry';
import { CONTROLS, Option } from './controls.component';

/**
 * Edit a shape: rectangle (with rounded corners), ellipse, or a custom SVG path (pasted, uploaded
 * as an SVG mask, or the built-in heart). Used for printable-area masks and layer clipping.
 */
@Component({
  selector: 'app-shape-field',
  imports: [CONTROLS, TranslatePipe],
  template: `
    <div class="panel-section">
      <app-select
        [label]="label() ?? ('addarea.shape' | t)"
        [options]="options()"
        [value]="kind()"
        (changed)="setKind($event)"
      />
      @if (shape(); as s) {
        @if (s.type === 'rect') {
          <app-num
            [label]="'inspector.shape.corner-radius' | t"
            [value]="round((s.cornerRadius ?? 0) * 200)"
            [min]="0"
            [max]="100"
            (changed)="changed.emit({ type: 'rect', cornerRadius: $event / 200 || undefined })"
          />
        }
        @if (s.type === 'path') {
          <app-text-in
            [label]="'inspector.shape.path-data' | t"
            [multiline]="true"
            [value]="s.d"
            (changed)="setPath($event, s.viewBox)"
          />
          <div class="row row--end">
            <app-num
              [label]="'inspector.shape.vb-width' | t"
              [value]="s.viewBox[0]"
              [min]="1"
              (changed)="setPath(s.d, [$event, s.viewBox[1]])"
            />
            <app-num
              [label]="'inspector.shape.vb-height' | t"
              [value]="s.viewBox[1]"
              [min]="1"
              (changed)="setPath(s.d, [s.viewBox[0], $event])"
            />
          </div>
          <div class="row row--end">
            <app-file
              [label]="'addarea.upload-svg' | t"
              accept="image/svg+xml,.svg"
              (chosen)="readSvg($event)"
            />
            <button type="button" class="btn" (click)="changed.emit(heart)">
              {{ 'inspector.shape.use-heart' | t }}
            </button>
          </div>
        }
      }
      @if (problem(); as text) {
        <p class="field-error" role="alert">{{ text }}</p>
      }
    </div>
  `,
})
export class ShapeFieldComponent {
  private readonly i18n = inject(I18n);
  /** Defaults to "Shape". */
  readonly label = input<string | null>(null);
  readonly shape = input<ShapeSpec | null>(null);
  /** Layers may have no clipping at all; printable areas always have a shape. */
  readonly allowNone = input(false);
  readonly changed = output<ShapeSpec | null>();

  protected readonly heart = HEART_SHAPE;
  protected readonly problem = signal<string | null>(null);
  protected readonly kind = computed(() => this.shape()?.type ?? 'none');
  protected readonly options = computed<Option[]>(() => [
    ...(this.allowNone() ? [{ value: 'none', label: this.i18n.t('inspector.shape.none') }] : []),
    { value: 'rect', label: this.i18n.t('inspector.shape.rect') },
    { value: 'ellipse', label: this.i18n.t('inspector.shape.ellipse') },
    { value: 'path', label: this.i18n.t('inspector.shape.path') },
  ]);

  protected round(value: number): number {
    return Math.round(value);
  }

  protected setKind(kind: string): void {
    this.problem.set(null);
    if (kind === 'none') this.changed.emit(null);
    else if (kind === 'rect') this.changed.emit({ type: 'rect' });
    else if (kind === 'ellipse') this.changed.emit({ type: 'ellipse' });
    else this.changed.emit(HEART_SHAPE);
  }

  protected setPath(d: string, viewBox: readonly [number, number]): void {
    if (!isSafePathData(d)) {
      this.problem.set(this.i18n.t('inspector.shape.error.path'));
      return;
    }
    this.problem.set(null);
    this.changed.emit({ type: 'path', d, viewBox: [viewBox[0], viewBox[1]] });
  }

  protected async readSvg(file: File): Promise<void> {
    const mask = parseSvgMask(await file.text());
    if (!mask) {
      this.problem.set(this.i18n.t('inspector.shape.error.svg'));
      return;
    }
    this.problem.set(null);
    this.changed.emit(mask);
  }
}
