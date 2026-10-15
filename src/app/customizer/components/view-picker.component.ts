import { Component, ElementRef, effect, input, output, viewChildren } from '@angular/core';
import { PreviewComposite } from '../services/render.service';

const THUMB = 64;

/** Thumbnails of the applicable mockup views; drawn from the already decoded bitmaps. */
@Component({
  selector: 'app-view-picker',
  template: `
    <fieldset class="field view-picker">
      <legend class="sr-only">Product views</legend>
      <div class="view-row">
        @for (view of views(); track view.mockup.id) {
          <label class="view-card" [class.view-selected]="view.mockup.id === selected()">
            <input
              type="radio"
              class="sr-only"
              name="product-view"
              [value]="view.mockup.id"
              [checked]="view.mockup.id === selected()"
              (change)="picked.emit(view.mockup.id)"
            />
            <canvas #thumb class="view-thumb" aria-hidden="true"></canvas>
            <span class="view-name">{{ view.mockup.name }}</span>
          </label>
        }
      </div>
    </fieldset>
  `,
})
export class ViewPickerComponent {
  readonly views = input.required<readonly PreviewComposite[]>();
  readonly selected = input<string | null>(null);
  readonly picked = output<string>();

  private readonly thumbs = viewChildren<ElementRef<HTMLCanvasElement>>('thumb');

  constructor() {
    effect(() => {
      const views = this.views();
      this.thumbs().forEach((ref, index) => {
        const bitmap = views[index]?.bitmap;
        const canvas = ref.nativeElement;
        if (!bitmap) return;
        const scale = THUMB / Math.max(bitmap.width, bitmap.height);
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      });
    });
  }
}
