import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { IconComponent } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { EditorStore } from '../services/editor-store.service';
import { StageComponent } from './stage.component';

/**
 * The centre of the editor: a compact toolbar, the canvas, zoom controls and the guidance that
 * explains what to do when there is nothing to show yet.
 */
@Component({
  selector: 'app-workspace',
  imports: [IconComponent, MenuComponent, StageComponent, TranslatePipe],
  template: `
    <div class="canvas-toolbar" role="toolbar" [attr.aria-label]="'editor.toolbar' | t">
      <div class="segmented" role="group" [attr.aria-label]="'editor.what-to-edit' | t">
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="store.view() === 'mockup'"
          (click)="store.view.set('mockup')"
        >
          <app-icon name="mockup" [size]="16" /> {{ 'editor.tab.photo' | t }}
        </button>
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="store.view() === 'artwork'"
          (click)="store.view.set('artwork')"
        >
          <app-icon name="artwork" [size]="16" /> {{ 'editor.tab.artwork' | t }}
        </button>
      </div>

      @if (store.config(); as c) {
        @if (store.view() === 'mockup') {
          @if (c.mockups.length > 0) {
            <label class="toolbar-select">
              <span class="sr-only">{{ 'inspector.mockup' | t }}</span>
              <select
                class="input"
                (change)="store.select({ kind: 'mockup', id: $any($event.target).value })"
              >
                @for (m of c.mockups; track m.id) {
                  <option [value]="m.id" [selected]="m.id === store.mockup()?.id">
                    {{ m.name }}
                  </option>
                }
              </select>
            </label>
          }
        } @else {
          @if (c.printableAreas.length > 0) {
            <label class="toolbar-select">
              <span class="sr-only">{{ 'inspector.area' | t }}</span>
              <select
                class="input"
                (change)="store.select({ kind: 'area', id: $any($event.target).value })"
              >
                @for (a of c.printableAreas; track a.id) {
                  <option [value]="a.id" [selected]="a.id === store.area()?.id">
                    {{ a.name }}
                  </option>
                }
              </select>
            </label>
            @if (areaArtworks().length > 1) {
              <label class="toolbar-select">
                <span class="sr-only">{{ 'editor.tab.artwork' | t }}</span>
                <select
                  class="input"
                  (change)="store.select({ kind: 'artwork', id: $any($event.target).value })"
                >
                  @for (a of areaArtworks(); track a.id) {
                    <option [value]="a.id" [selected]="a.id === store.artwork()?.id">
                      {{ a.name }}
                    </option>
                  }
                </select>
              </label>
            }
          }
        }
      }

      <span class="toolbar-divider" aria-hidden="true"></span>
      <button
        type="button"
        class="btn btn--icon btn--ghost"
        [attr.aria-label]="'editor.tool.select-aria' | t"
        [attr.data-tip]="'editor.tool.select-tip' | t"
        [attr.aria-pressed]="store.tool().kind === 'select'"
        (click)="store.tool.set({ kind: 'select' })"
      >
        <app-icon name="cursor" />
      </button>
      <button
        type="button"
        class="btn btn--icon btn--ghost"
        [attr.aria-label]="'editor.tool.pan-aria' | t"
        [attr.data-tip]="'editor.tool.pan-tip' | t"
        [attr.aria-pressed]="store.tool().kind === 'pan'"
        (click)="store.tool.set({ kind: 'pan' })"
      >
        <app-icon name="hand" />
      </button>
      <button type="button" class="btn btn--ghost" (click)="store.addAreaDialogOpen.set(true)">
        <app-icon name="plus" [size]="16" /> {{ 'areas.add' | t }}
      </button>
      @if (store.tool().kind === 'draw') {
        <button type="button" class="btn btn--sm" (click)="store.tool.set({ kind: 'select' })">
          {{ 'editor.tool.cancel-draw' | t }}
        </button>
      }

      <span class="grow"></span>
      <app-menu [label]="'editor.view-options' | t" icon="sliders" variant="ghost" align="end">
        <button
          type="button"
          class="menu-item"
          role="menuitemcheckbox"
          [attr.aria-checked]="store.showBoundaries()"
          (click)="store.showBoundaries.set(!store.showBoundaries())"
        >
          <app-icon [name]="store.showBoundaries() ? 'check' : 'minus'" [size]="16" />
          {{ 'editor.show-boundaries' | t }}
        </button>
        <button
          type="button"
          class="menu-item"
          role="menuitemcheckbox"
          [attr.aria-checked]="store.sampleContent()"
          (click)="store.setSampleContent(!store.sampleContent())"
        >
          <app-icon [name]="store.sampleContent() ? 'check' : 'minus'" [size]="16" />
          <span
            >{{ 'editor.sample-slots' | t
            }}<small>{{ 'editor.sample-slots-hint' | t }}</small></span
          >
        </button>
      </app-menu>
    </div>

    <div class="canvas-area">
      <app-stage />

      <div class="mode-chip">
        <app-icon [name]="store.view() === 'mockup' ? 'mockup' : 'artwork'" [size]="16" />
        <span>{{ modeLabel() }}</span>
      </div>

      <div class="zoom-controls" role="group" [attr.aria-label]="'editor.zoom' | t">
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          [attr.aria-label]="'editor.zoom-out' | t"
          [attr.data-tip]="'editor.zoom-out' | t"
          data-tip-side="top"
          (click)="stage()?.zoomBy(1 / 1.25)"
        >
          <app-icon name="zoom-out" [size]="16" />
        </button>
        <button
          type="button"
          class="zoom-value"
          [attr.aria-label]="'editor.zoom-reset' | t: { zoom: stage()?.zoomLabel() ?? '100%' }"
          (click)="stage()?.zoomActual()"
        >
          {{ stage()?.zoomLabel() ?? '100%' }}
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          [attr.aria-label]="'editor.zoom-in' | t"
          [attr.data-tip]="'editor.zoom-in' | t"
          data-tip-side="top"
          (click)="stage()?.zoomBy(1.25)"
        >
          <app-icon name="zoom-in" [size]="16" />
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          [attr.aria-label]="'editor.fit' | t"
          [attr.data-tip]="'editor.fit' | t"
          data-tip-side="top"
          (click)="stage()?.fit()"
        >
          <app-icon name="fit" [size]="16" />
        </button>
      </div>

      @if (store.config(); as c) {
        @if (c.mockups.length === 0) {
          <div
            class="canvas-empty"
            [class.is-dragging]="dragging()"
            (dragover)="onDragOver($event)"
            (dragleave)="dragging.set(false)"
            (drop)="onDrop($event)"
          >
            <span class="canvas-empty__icon"><app-icon name="image" [size]="28" /></span>
            <h2>{{ 'editor.empty.photo.title' | t }}</h2>
            <p class="muted">
              {{ 'editor.empty.photo.text' | t }}
            </p>
            <label class="btn btn--primary">
              <app-icon name="upload" [size]="16" /> {{ 'editor.empty.photo.upload' | t }}
              <input
                class="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                (change)="onFile($event)"
              />
            </label>
          </div>
        } @else if (
          store.view() === 'mockup' && store.mockup() && store.mockup()!.placements.length === 0
        ) {
          <div class="canvas-hint">
            <span>{{ 'inspector.mockup.no-areas' | t }}</span>
            <button
              type="button"
              class="btn btn--sm btn--primary"
              (click)="store.addAreaDialogOpen.set(true)"
            >
              {{ 'addarea.title' | t }}
            </button>
          </div>
        } @else if (store.view() === 'artwork' && !store.area()) {
          <div class="canvas-empty">
            <span class="canvas-empty__icon"><app-icon name="area" [size]="28" /></span>
            <h2>{{ 'editor.empty.area.title' | t }}</h2>
            <p class="muted">
              {{ 'editor.empty.area.text' | t }}
            </p>
            <button
              type="button"
              class="btn btn--primary"
              (click)="store.addAreaDialogOpen.set(true)"
            >
              {{ 'addarea.title' | t }}
            </button>
          </div>
        } @else if (
          store.view() === 'artwork' && store.artwork() && store.artwork()!.layers.length === 0
        ) {
          <div class="canvas-hint">
            <span>{{ 'editor.empty.artwork' | t }}</span>
            <button
              type="button"
              class="btn btn--sm btn--primary"
              (click)="store.sidebarTab.set('layers')"
            >
              {{ 'inspector.artwork.open-layers' | t }}
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class WorkspaceComponent {
  private readonly i18n = inject(I18n);
  protected readonly store = inject(EditorStore);
  protected readonly stage = viewChild(StageComponent);
  protected readonly dragging = signal(false);

  protected readonly areaArtworks = computed(() => {
    const c = this.store.config();
    const area = this.store.area();
    return c && area ? c.artworks.filter((a) => a.printableAreaId === area.id) : [];
  });

  protected readonly modeLabel = computed(() => {
    if (this.store.view() === 'mockup') return this.i18n.t('editor.mode.photo');
    const area = this.store.area();
    return area
      ? this.i18n.t('editor.mode.artwork-area', {
          name: area.name,
          width: area.canvas.width,
          height: area.canvas.height,
        })
      : this.i18n.t('editor.tab.artwork');
  });

  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.store.addMockupFromFile(file);
  }

  protected onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      this.dragging.set(true);
    }
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.store.addMockupFromFile(file);
  }
}
