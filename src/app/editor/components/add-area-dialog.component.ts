import { Component, computed, inject, signal } from '@angular/core';
import { ShapeSpec } from '../../customizer/models/product.models';
import { HEART_SHAPE, isSafePathData, parseSvgMask } from '../../customizer/util/geometry';
import { DialogComponent } from '../../ui/dialog.component';
import { IconComponent, IconName } from '../../ui/icon.component';
import { EditorStore } from '../services/editor-store.service';

type Kind = 'rect' | 'ellipse' | 'path';

interface Option {
  id: Kind;
  title: string;
  description: string;
  icon: IconName;
}

/**
 * "Add printable area": choose the shape, then draw it on the mockup. A custom shape is an SVG
 * outline (uploaded or pasted) that becomes the production mask.
 */
@Component({
  selector: 'app-add-area-dialog',
  imports: [DialogComponent, IconComponent],
  template: `
    <app-dialog
      [open]="store.addAreaDialogOpen()"
      title="Add printable area"
      description="Choose the shape of the region that gets printed. You will draw it on the product photo."
      [width]="540"
      (closed)="close()"
    >
      <fieldset class="stack stack--tight">
        <legend class="sr-only">Shape</legend>
        <div class="option-grid">
          @for (o of options; track o.id) {
            <label class="option-card" [class.is-selected]="kind() === o.id">
              <input
                class="sr-only"
                type="radio"
                name="area-shape"
                [value]="o.id"
                [checked]="kind() === o.id"
                (change)="kind.set(o.id)"
              />
              <app-icon [name]="o.icon" [size]="22" />
              <span class="option-card__title">{{ o.title }}</span>
              <span class="option-card__text">{{ o.description }}</span>
            </label>
          }
        </div>
      </fieldset>

      @if (kind() === 'path') {
        <div class="stack stack--tight custom-shape">
          <div class="row">
            <label class="btn btn--sm">
              <app-icon name="upload" [size]="16" />
              <span>Upload SVG mask</span>
              <input
                class="sr-only"
                type="file"
                accept="image/svg+xml,.svg"
                (change)="onSvg($event)"
              />
            </label>
            <button type="button" class="btn btn--sm" (click)="useHeart()">Heart</button>
          </div>
          <label class="field">
            <span class="field-label">Or paste SVG path data</span>
            <textarea
              class="input"
              rows="3"
              spellcheck="false"
              placeholder="M50 92 C 20 68 2 50 2 30 …"
              [value]="pathText()"
              (input)="onPath($any($event.target).value)"
            ></textarea>
          </label>
          @if (pathProblem(); as message) {
            <p class="field-error" role="alert">{{ message }}</p>
          }
          @if (custom(); as c) {
            <div class="row">
              <svg
                class="shape-preview"
                [attr.viewBox]="'0 0 ' + c.viewBox[0] + ' ' + c.viewBox[1]"
                role="img"
                aria-label="Preview of the custom shape"
              >
                <path [attr.d]="c.d" />
              </svg>
              <span class="field-hint">Preview. The shape scales to the area you draw.</span>
            </div>
          }
        </div>
      }

      @if (!store.mockup()) {
        <p class="notice notice--warning">
          <app-icon name="alert" />
          <span
            >Printable areas are placed on a product photo. Add a mockup first, then come back
            here.</span
          >
        </p>
      }

      <ng-container dialogActions>
        <button type="button" class="btn" (click)="close()">Cancel</button>
        <button type="button" class="btn" [disabled]="!ready()" (click)="placeAtCentre()">
          Place in the centre
        </button>
        <button type="button" class="btn btn--primary" [disabled]="!ready()" (click)="draw()">
          <app-icon name="pen" [size]="16" /> Draw on mockup
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class AddAreaDialogComponent {
  protected readonly store = inject(EditorStore);

  protected readonly options: Option[] = [
    {
      id: 'rect',
      title: 'Rectangle',
      description: 'Labels, chest prints, photo panels',
      icon: 'square',
    },
    {
      id: 'ellipse',
      title: 'Circle or ellipse',
      description: 'Round coasters, caps, badges',
      icon: 'circle',
    },
    { id: 'path', title: 'Custom shape', description: 'Any outline from an SVG', icon: 'vector' },
  ];

  protected readonly kind = signal<Kind>('rect');
  protected readonly custom = signal<Extract<ShapeSpec, { type: 'path' }> | null>(null);
  protected readonly pathText = signal('');
  protected readonly pathProblem = signal<string | null>(null);

  protected readonly shape = computed<ShapeSpec | null>(() => {
    const kind = this.kind();
    return kind === 'path' ? this.custom() : { type: kind };
  });
  protected readonly ready = computed(() => !!this.shape() && !!this.store.mockup());

  protected async onSvg(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const mask = parseSvgMask(await file.text());
    if (!mask) {
      this.custom.set(null);
      this.pathProblem.set(
        'That SVG has no usable outline. It needs a viewBox and a path, polygon, circle, ellipse or rect.',
      );
      return;
    }
    this.pathProblem.set(null);
    this.pathText.set(mask.d);
    this.custom.set(mask);
  }

  protected onPath(text: string): void {
    this.pathText.set(text);
    if (!text.trim()) {
      this.custom.set(null);
      this.pathProblem.set(null);
      return;
    }
    if (!isSafePathData(text)) {
      this.custom.set(null);
      this.pathProblem.set(
        'Path data must start with M and use only SVG path commands and numbers.',
      );
      return;
    }
    this.pathProblem.set(null);
    this.custom.set({ type: 'path', d: text, viewBox: this.custom()?.viewBox ?? [100, 100] });
  }

  protected useHeart(): void {
    this.pathProblem.set(null);
    this.pathText.set(HEART_SHAPE.d);
    this.custom.set(HEART_SHAPE);
  }

  protected close(): void {
    this.store.addAreaDialogOpen.set(false);
  }

  protected draw(): void {
    const shape = this.shape();
    if (!shape) return;
    this.store.view.set('mockup');
    this.store.tool.set({ kind: 'draw', shape });
    this.close();
  }

  protected placeAtCentre(): void {
    const shape = this.shape();
    if (!shape) return;
    this.store.view.set('mockup');
    this.store.addAreaDefault(shape);
    this.close();
  }
}
