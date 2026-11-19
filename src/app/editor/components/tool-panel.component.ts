import { Component, inject } from '@angular/core';
import { TranslatePipe } from '../../admin/i18n/i18n.service';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import { BRUSH_LIMITS } from '../util/mask-painter';
import { CONTROLS } from './controls.component';

/**
 * Controls of the active drawing tool. They belong to the TOOL, not to a selection: the Brush Mask
 * tool starts on a new area that does not exist until the first stroke, so its size and hardness must
 * be reachable before there is anything to select.
 */
@Component({
  selector: 'app-tool-panel',
  imports: [CONTROLS, SectionComponent, TranslatePipe],
  template: `
    @if (store.tool().kind === 'brush') {
      <app-section [title]="'inspector.brush.title' | t">
        <div class="row" role="group" [attr.aria-label]="'inspector.brush.mode' | t">
          <button
            type="button"
            class="btn btn--sm"
            [class.btn--primary]="store.brush().mode === 'add'"
            [attr.aria-pressed]="store.brush().mode === 'add'"
            (click)="mode('add')"
          >
            {{ 'inspector.brush.add' | t }}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            [class.btn--primary]="store.brush().mode === 'erase'"
            [attr.aria-pressed]="store.brush().mode === 'erase'"
            (click)="mode('erase')"
          >
            {{ 'inspector.brush.erase' | t }}
          </button>
        </div>
        <app-range
          [label]="'inspector.brush.size' | t"
          [value]="store.brush().size"
          [min]="limits.minSize"
          [max]="limits.maxSize"
          (changed)="size($event)"
        />
        <app-range
          [label]="'inspector.brush.hardness' | t"
          [value]="percent(store.brush().hardness)"
          [min]="0"
          [max]="100"
          unit="%"
          (changed)="hardness($event)"
        />
        <div class="row">
          <button type="button" class="btn btn--sm" (click)="clear()">
            {{ 'inspector.brush.clear' | t }}
          </button>
          <button type="button" class="btn btn--sm" (click)="fit()">
            {{ 'inspector.brush.fit' | t }}
          </button>
          <button type="button" class="btn btn--sm btn--primary" (click)="done()">
            {{ 'common.done' | t }}
          </button>
        </div>
      </app-section>
    } @else if (store.tool().kind === 'pen') {
      <app-section [title]="'inspector.pen.title' | t">
        <p class="field-hint">{{ 'inspector.pen.hint' | t }}</p>
        <button type="button" class="btn btn--sm btn--primary" (click)="done()">
          {{ 'common.done' | t }}
        </button>
      </app-section>
    }
  `,
})
export class ToolPanelComponent {
  protected readonly store = inject(EditorStore);
  protected readonly limits = BRUSH_LIMITS;

  protected percent(hardness: number): number {
    return Math.round(hardness * 100);
  }

  protected mode(mode: 'add' | 'erase'): void {
    this.store.brush.update((b) => ({ ...b, mode }));
  }

  protected size(size: number): void {
    this.store.brush.update((b) => ({ ...b, size: Math.round(size) }));
  }

  protected hardness(percent: number): void {
    this.store.brush.update((b) => ({ ...b, hardness: percent / 100 }));
  }

  protected clear(): void {
    this.store.brushCommand.set({ kind: 'clear', n: Date.now() });
  }

  protected fit(): void {
    this.store.brushCommand.set({ kind: 'fit', n: Date.now() });
  }

  protected done(): void {
    this.store.penAnchor.set(null);
    this.store.tool.set({ kind: 'select' });
  }
}
