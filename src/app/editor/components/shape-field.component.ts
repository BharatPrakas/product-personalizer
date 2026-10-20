import { Component, computed, input, output, signal } from '@angular/core';
import { ShapeSpec } from '../../customizer/models/product.models';
import { HEART_SHAPE, isSafePathData, parseSvgMask } from '../../customizer/util/geometry';
import { CONTROLS, Option } from './controls.component';

/**
 * Edit a shape: rectangle (with rounded corners), ellipse, or a custom SVG path (pasted, uploaded
 * as an SVG mask, or the built-in heart). Used for printable-area masks and layer clipping.
 */
@Component({
  selector: 'app-shape-field',
  imports: [CONTROLS],
  template: `
    <div class="panel-section">
      <app-select
        [label]="label()"
        [options]="options()"
        [value]="kind()"
        (changed)="setKind($event)"
      />
      @if (shape(); as s) {
        @if (s.type === 'rect') {
          <app-num
            label="Corner radius (%)"
            [value]="round((s.cornerRadius ?? 0) * 200)"
            [min]="0"
            [max]="100"
            (changed)="changed.emit({ type: 'rect', cornerRadius: $event / 200 || undefined })"
          />
        }
        @if (s.type === 'path') {
          <app-text-in
            label="SVG path data (d)"
            [multiline]="true"
            [value]="s.d"
            (changed)="setPath($event, s.viewBox)"
          />
          <div class="row row--end">
            <app-num
              label="View box width"
              [value]="s.viewBox[0]"
              [min]="1"
              (changed)="setPath(s.d, [$event, s.viewBox[1]])"
            />
            <app-num
              label="View box height"
              [value]="s.viewBox[1]"
              [min]="1"
              (changed)="setPath(s.d, [s.viewBox[0], $event])"
            />
          </div>
          <div class="row row--end">
            <app-file
              label="Upload SVG mask"
              accept="image/svg+xml,.svg"
              (chosen)="readSvg($event)"
            />
            <button type="button" class="btn" (click)="changed.emit(heart)">Use heart</button>
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
  readonly label = input('Shape');
  readonly shape = input<ShapeSpec | null>(null);
  /** Layers may have no clipping at all; printable areas always have a shape. */
  readonly allowNone = input(false);
  readonly changed = output<ShapeSpec | null>();

  protected readonly heart = HEART_SHAPE;
  protected readonly problem = signal<string | null>(null);
  protected readonly kind = computed(() => this.shape()?.type ?? 'none');
  protected readonly options = computed<Option[]>(() => [
    ...(this.allowNone() ? [{ value: 'none', label: 'None' }] : []),
    { value: 'rect', label: 'Rectangle' },
    { value: 'ellipse', label: 'Ellipse / circle' },
    { value: 'path', label: 'Custom SVG path' },
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
      this.problem.set(
        'Path data must start with M and use only SVG path commands, numbers and separators.',
      );
      return;
    }
    this.problem.set(null);
    this.changed.emit({ type: 'path', d, viewBox: [viewBox[0], viewBox[1]] });
  }

  protected async readSvg(file: File): Promise<void> {
    const mask = parseSvgMask(await file.text());
    if (!mask) {
      this.problem.set(
        'That SVG has no usable outline (needs a viewBox and a path, polygon, circle, ellipse or rect).',
      );
      return;
    }
    this.problem.set(null);
    this.changed.emit(mask);
  }
}
