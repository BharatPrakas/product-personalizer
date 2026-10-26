import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { AreaCanvasCache, PreviewComposite, RenderService } from '../services/render.service';

const MAX_BACKING_EDGE = 2400;

/**
 * Live preview: the mockup with every active printable area composed into its placement. Each
 * area is rendered on its own canvas and cached, so a change in one area repaints only that area's
 * artwork (the mockup compositing itself is cheap).
 */
@Component({
  selector: 'app-preview',
  template: `
    <div class="preview-frame" part="preview-frame" #frame>
      <canvas
        #canvas
        class="preview-canvas"
        role="img"
        [attr.aria-label]="label()"
        [style.aspect-ratio]="composite().bitmap.width + ' / ' + composite().bitmap.height"
      ></canvas>
    </div>
  `,
})
export class PreviewComponent {
  private readonly render = inject(RenderService);
  private readonly cache = new AreaCanvasCache();

  readonly composite = input.required<PreviewComposite>();
  readonly label = input.required<string>();

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private readonly cssWidth = signal(0);

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.cache.dispose());
    afterNextRender(() => {
      const frame = this.frame().nativeElement;
      this.cssWidth.set(frame.clientWidth);
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (Math.round(width) !== Math.round(this.cssWidth())) this.cssWidth.set(width);
      });
      observer.observe(frame);
      destroyRef.onDestroy(() => observer.disconnect());
    });

    effect(() => {
      const cssWidth = this.cssWidth();
      const composite = this.composite();
      if (cssWidth <= 0) return;
      // Device pixel ratio only affects sharpness of this display canvas, never exported pixels.
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.min(MAX_BACKING_EDGE, Math.max(1, Math.round(cssWidth * ratio)));
      const height = Math.max(
        1,
        Math.round((width * composite.bitmap.height) / composite.bitmap.width),
      );
      const canvas = this.canvas().nativeElement;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      this.render.paintDisplay(canvas, composite, this.cache);
    });
  }
}
