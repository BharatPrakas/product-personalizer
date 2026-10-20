import { Component, ElementRef, computed, effect, inject, input, viewChild } from '@angular/core';
import { EditorStore } from '../services/editor-store.service';
import { IconComponent } from '../../ui/icon.component';

/** A small picture of a mockup, drawn from the image the editor already decoded. */
@Component({
  selector: 'app-mockup-thumb',
  imports: [IconComponent],
  template: `
    <canvas #canvas class="mockup-thumb-canvas" [hidden]="!bitmap()" aria-hidden="true"></canvas>
    @if (!bitmap()) {
      <app-icon name="mockup" [size]="18" />
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      overflow: hidden;
      color: var(--c-text-subtle);
      background: var(--c-surface-muted);
      border: 1px solid var(--c-border);
      border-radius: var(--r-sm);
      flex: none;
    }
    .mockup-thumb-canvas {
      width: 100%;
      height: 100%;
    }
  `,
})
export class MockupThumbComponent {
  private readonly store = inject(EditorStore);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly mockupId = input.required<string>();

  protected readonly bitmap = computed(() => {
    const resolved = this.store.resolvedConfig()?.mockups.find((m) => m.id === this.mockupId());
    return resolved ? (this.store.assets.staticImages().get(resolved.src) ?? null) : null;
  });

  constructor() {
    effect(() => {
      const bitmap = this.bitmap();
      const canvas = this.canvas().nativeElement;
      if (!bitmap) return;
      const size = 88;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // object-fit: cover
      const scale = Math.max(size / bitmap.width, size / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
    });
  }
}
