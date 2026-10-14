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
import { MockupPlacement } from '../models/config.models';
import { RenderService } from '../services/render.service';
import { Scene } from '../util/scene';

const MAX_BACKING_EDGE = 2400;

/** Live preview: the mockup with the shared scene drawn into its placement rectangle. */
@Component({
  selector: 'app-preview',
  template: `
    <div class="preview-frame" #frame>
      <canvas
        #canvas
        class="preview-canvas"
        role="img"
        [attr.aria-label]="label()"
        [style.aspect-ratio]="mockup().width + ' / ' + mockup().height"
      ></canvas>
    </div>
  `,
})
export class PreviewComponent {
  private readonly render = inject(RenderService);

  readonly mockup = input.required<ImageBitmap>();
  readonly placement = input.required<MockupPlacement>();
  readonly scene = input.required<Scene>();
  readonly label = input.required<string>();

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private readonly cssWidth = signal(0);

  constructor() {
    const destroyRef = inject(DestroyRef);
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
      const mockup = this.mockup();
      const scene = this.scene();
      const placement = this.placement();
      if (cssWidth <= 0) return;
      // Device pixel ratio only affects sharpness of this display canvas, never exported pixels.
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.min(MAX_BACKING_EDGE, Math.max(1, Math.round(cssWidth * ratio)));
      const height = Math.max(1, Math.round((width * mockup.height) / mockup.width));
      const canvas = this.canvas().nativeElement;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      this.render.paintDisplay(canvas, mockup, placement, scene);
    });
  }
}
