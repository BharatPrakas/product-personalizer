import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { Component, computed, inject, signal } from '@angular/core';
import type { MessageKey } from '../../admin/i18n/messages.en';
import { ShapeSpec } from '../../customizer/models/product.models';
import { HEART_SHAPE, isSafePathData, parseSvgMask } from '../../customizer/util/geometry';
import { DialogComponent } from '../../ui/dialog.component';
import { IconComponent, IconName } from '../../ui/icon.component';
import { EditorStore } from '../services/editor-store.service';

type Kind = 'rect' | 'ellipse' | 'path';

interface Option {
  id: Kind;
  title: MessageKey;
  description: MessageKey;
  icon: IconName;
}

/**
 * "Add printable area": choose the shape, then draw it on the mockup. A custom shape is an SVG
 * outline (uploaded or pasted) that becomes the production mask.
 */
@Component({
  selector: 'app-add-area-dialog',
  imports: [DialogComponent, IconComponent, TranslatePipe],
  template: `
    <app-dialog
      [open]="store.addAreaDialogOpen()"
      [title]="'addarea.title' | t"
      [description]="'addarea.description' | t"
      [width]="540"
      (closed)="close()"
    >
      <fieldset class="stack stack--tight">
        <legend class="sr-only">{{ 'addarea.shape' | t }}</legend>
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
              <span class="option-card__title">{{ o.title | t }}</span>
              <span class="option-card__text">{{ o.description | t }}</span>
            </label>
          }
        </div>
      </fieldset>

      @if (kind() === 'path') {
        <div class="stack stack--tight custom-shape">
          <div class="row">
            <label class="btn btn--sm">
              <app-icon name="upload" [size]="16" />
              <span>{{ 'addarea.upload-svg' | t }}</span>
              <input
                class="sr-only"
                type="file"
                accept="image/svg+xml,.svg"
                (change)="onSvg($event)"
              />
            </label>
            <button type="button" class="btn btn--sm" (click)="useHeart()">
              {{ 'addarea.heart' | t }}
            </button>
          </div>
          <label class="field">
            <span class="field-label">{{ 'addarea.paste' | t }}</span>
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
                [attr.aria-label]="'addarea.preview-aria' | t"
              >
                <path [attr.d]="c.d" />
              </svg>
              <span class="field-hint">{{ 'addarea.preview-hint' | t }}</span>
            </div>
          }
        </div>
      }

      @if (!store.mockup()) {
        <p class="notice notice--warning">
          <app-icon name="alert" />
          <span>{{ 'addarea.need-mockup' | t }}</span>
        </p>
      }

      <ng-container dialogActions>
        <button type="button" class="btn" (click)="close()">{{ 'common.cancel' | t }}</button>
        <button type="button" class="btn" [disabled]="!ready()" (click)="placeAtCentre()">
          {{ 'addarea.centre' | t }}
        </button>
        <button type="button" class="btn btn--primary" [disabled]="!ready()" (click)="draw()">
          <app-icon name="pen" [size]="16" /> {{ 'addarea.draw' | t }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class AddAreaDialogComponent {
  private readonly i18n = inject(I18n);
  protected readonly store = inject(EditorStore);

  protected readonly options: Option[] = [
    {
      id: 'rect',
      title: 'addarea.opt.rect.title',
      description: 'addarea.opt.rect.desc',
      icon: 'square',
    },
    {
      id: 'ellipse',
      title: 'addarea.opt.ellipse.title',
      description: 'addarea.opt.ellipse.desc',
      icon: 'circle',
    },
    {
      id: 'path',
      title: 'addarea.opt.path.title',
      description: 'addarea.opt.path.desc',
      icon: 'vector',
    },
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
      this.pathProblem.set(this.i18n.t('addarea.error.svg'));
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
      this.pathProblem.set(this.i18n.t('addarea.error.path'));
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
