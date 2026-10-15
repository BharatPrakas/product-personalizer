import { Component, computed, inject } from '@angular/core';
import { ArtworkLayer, PrintableArea, ProductMockup } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';

const LAYER_ICON: Record<ArtworkLayer['type'], string> = {
  'fixed-image': '▣',
  'image-placeholder': '▨',
  text: 'T',
  artwork: '★',
  shape: '◆',
};

/** Left panel: product, variants, mockups, printable areas, artworks and the layers of the open artwork. */
@Component({
  selector: 'app-structure-panel',
  imports: [CONTROLS],
  template: `
    @if (store.config(); as c) {
      <nav class="ed-tree" aria-label="Product structure">
        <section class="ed-section">
          <h3 class="ed-section-title">Product</h3>
          <button
            type="button"
            class="ed-row-btn"
            [class.is-selected]="store.selection().kind === 'product'"
            (click)="store.select({ kind: 'product' })"
          >
            <span class="ed-ellipsis">{{ c.product.name }}</span>
            <span class="ed-badge">{{ c.status }}</span>
          </button>
          @for (v of c.variants; track v.id) {
            <button
              type="button"
              class="ed-row-btn ed-indent"
              [class.is-selected]="isSelected('variant', v.id)"
              (click)="store.select({ kind: 'variant', id: v.id })"
            >
              <span class="ed-ellipsis">Variant: {{ v.label }}</span>
            </button>
          }
        </section>

        <section class="ed-section">
          <h3 class="ed-section-title">Mockups</h3>
          @for (m of c.mockups; track m.id) {
            <div class="ed-row-line">
              <button
                type="button"
                class="ed-row-btn"
                [class.is-selected]="isSelected('mockup', m.id)"
                (click)="store.select({ kind: 'mockup', id: m.id })"
              >
                <span class="ed-ellipsis">{{ m.name }}</span>
                <span class="ed-hint">{{ m.placements.length }} area(s)</span>
              </button>
              <button
                type="button"
                class="ed-icon-btn"
                [attr.aria-label]="(m.visible === false ? 'Show ' : 'Hide ') + m.name"
                [attr.aria-pressed]="m.visible !== false"
                (click)="toggleMockup(m)"
              >
                {{ m.visible === false ? '○' : '●' }}
              </button>
              <button
                type="button"
                class="ed-icon-btn"
                [attr.aria-label]="'Move ' + m.name + ' earlier'"
                (click)="moveMockup(m.id, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                class="ed-icon-btn"
                [attr.aria-label]="'Move ' + m.name + ' later'"
                (click)="moveMockup(m.id, 1)"
              >
                ↓
              </button>
            </div>
          }
          <app-file label="+ Upload mockup" (chosen)="store.addMockupFromFile($event)" />
        </section>

        <section class="ed-section">
          <h3 class="ed-section-title">Printable areas</h3>
          @for (a of c.printableAreas; track a.id) {
            <div class="ed-row-line">
              <button
                type="button"
                class="ed-row-btn"
                [class.is-selected]="isSelected('area', a.id)"
                (click)="store.select({ kind: 'area', id: a.id })"
              >
                <span class="ed-ellipsis" [class.ed-muted]="!a.enabled">{{ a.name }}</span>
                <span class="ed-hint">{{ a.canvas.width }}×{{ a.canvas.height }}</span>
              </button>
              <button
                type="button"
                class="ed-icon-btn"
                [attr.aria-label]="(a.enabled ? 'Disable ' : 'Enable ') + a.name"
                [attr.aria-pressed]="a.enabled"
                (click)="toggleArea(a)"
              >
                {{ a.enabled ? '●' : '○' }}
              </button>
              <button
                type="button"
                class="ed-icon-btn"
                [attr.aria-label]="'Edit artwork of ' + a.name"
                title="Edit artwork"
                (click)="store.editArea(a.id)"
              >
                ✎
              </button>
            </div>
            @for (art of artworksOf(a.id); track art.id) {
              <button
                type="button"
                class="ed-row-btn ed-indent"
                [class.is-selected]="isSelected('artwork', art.id)"
                (click)="store.select({ kind: 'artwork', id: art.id })"
              >
                <span class="ed-ellipsis">{{ art.name }}</span>
                @if (art.id === a.artworkId) {
                  <span class="ed-badge">default</span>
                }
                <span class="ed-hint">{{ art.layers.length }} layer(s)</span>
              </button>
            }
          }
          <div class="ed-row">
            <button type="button" class="ed-btn" (click)="store.addAreaDefault({ type: 'rect' })">
              + Rectangle
            </button>
            <button
              type="button"
              class="ed-btn"
              (click)="store.addAreaDefault({ type: 'ellipse' })"
            >
              + Circle
            </button>
          </div>
          <div class="ed-row">
            <button type="button" class="ed-btn" (click)="startDraw('rect')">
              Draw rectangle…
            </button>
            <button type="button" class="ed-btn" (click)="startDraw('ellipse')">
              Draw ellipse…
            </button>
          </div>
        </section>

        @if (store.artwork(); as art) {
          <section class="ed-section">
            <h3 class="ed-section-title">Layers · {{ art.name }}</h3>
            <p class="ed-hint">Front of the stack is at the top.</p>
            <ul class="ed-layer-list">
              @for (l of reversed(art.layers); track l.id) {
                <li class="ed-row-line">
                  <button
                    type="button"
                    class="ed-row-btn"
                    [class.is-selected]="isSelected('layer', l.id)"
                    (click)="store.select({ kind: 'layer', id: l.id })"
                  >
                    <span class="ed-type" aria-hidden="true">{{ icon(l) }}</span>
                    <span class="ed-ellipsis" [class.ed-muted]="l.visible === false">{{
                      l.name || l.type
                    }}</span>
                  </button>
                  <button
                    type="button"
                    class="ed-icon-btn"
                    [attr.aria-label]="
                      (l.visible === false ? 'Show ' : 'Hide ') + (l.name || l.type)
                    "
                    [attr.aria-pressed]="l.visible !== false"
                    (click)="toggleLayerVisible(l)"
                  >
                    {{ l.visible === false ? '○' : '●' }}
                  </button>
                  <button
                    type="button"
                    class="ed-icon-btn"
                    [attr.aria-label]="(l.locked ? 'Unlock ' : 'Lock ') + (l.name || l.type)"
                    [attr.aria-pressed]="l.locked === true"
                    (click)="toggleLayerLocked(l)"
                  >
                    {{ l.locked ? '🔒' : '🔓' }}
                  </button>
                  <button
                    type="button"
                    class="ed-icon-btn"
                    [attr.aria-label]="'Bring ' + (l.name || l.type) + ' forward'"
                    (click)="moveLayer(l.id, 'forward')"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="ed-icon-btn"
                    [attr.aria-label]="'Send ' + (l.name || l.type) + ' backward'"
                    (click)="moveLayer(l.id, 'backward')"
                  >
                    ↓
                  </button>
                </li>
              }
            </ul>
            <div class="ed-add-grid" role="group" aria-label="Add a layer">
              <button type="button" class="ed-btn" (click)="addLayer('image-placeholder')">
                + Photo slot
              </button>
              <button type="button" class="ed-btn" (click)="addLayer('text-editable')">
                + Editable text
              </button>
              <button type="button" class="ed-btn" (click)="addLayer('text-fixed')">
                + Fixed text
              </button>
              <button type="button" class="ed-btn" (click)="addLayer('artwork-choice')">
                + Clipart choice
              </button>
              <button type="button" class="ed-btn" (click)="addLayer('shape-rect')">
                + Rectangle
              </button>
              <button type="button" class="ed-btn" (click)="addLayer('shape-ellipse')">
                + Ellipse
              </button>
              <app-file label="+ Fixed image" (chosen)="addFixedImage($event)" />
            </div>
          </section>
        }
      </nav>
    }
  `,
})
export class StructurePanelComponent {
  protected readonly store = inject(EditorStore);
  protected readonly edit = edit;

  protected readonly selectedKey = computed(() => {
    const s = this.store.selection();
    return s.kind === 'product' ? 'product' : `${s.kind}:${s.id}`;
  });

  protected isSelected(kind: string, id: string): boolean {
    return this.selectedKey() === `${kind}:${id}`;
  }

  protected artworksOf(areaId: string) {
    return (this.store.config()?.artworks ?? []).filter((a) => a.printableAreaId === areaId);
  }

  protected reversed(layers: readonly ArtworkLayer[]): ArtworkLayer[] {
    return [...layers].reverse();
  }

  protected icon(layer: ArtworkLayer): string {
    return LAYER_ICON[layer.type];
  }

  protected toggleMockup(m: ProductMockup): void {
    this.store.edit((c) =>
      edit.updateMockup(c, m.id, { visible: m.visible === false ? undefined : false }),
    );
  }

  protected moveMockup(id: string, direction: -1 | 1): void {
    this.store.edit((c) => edit.moveMockup(c, id, direction));
  }

  protected toggleArea(a: PrintableArea): void {
    this.store.edit((c) => edit.updateArea(c, a.id, { enabled: !a.enabled }));
  }

  protected toggleLayerVisible(l: ArtworkLayer): void {
    this.store.edit((c) =>
      edit.updateLayer(c, l.id, { visible: l.visible === false ? undefined : false }),
    );
  }

  protected toggleLayerLocked(l: ArtworkLayer): void {
    this.store.edit((c) => edit.updateLayer(c, l.id, { locked: l.locked ? undefined : true }));
  }

  protected moveLayer(id: string, to: 'forward' | 'backward'): void {
    this.store.edit((c) => edit.moveLayer(c, id, to));
  }

  protected startDraw(shape: 'rect' | 'ellipse'): void {
    this.store.view.set('mockup');
    this.store.tool.set({ kind: 'draw', shape });
  }

  protected addLayer(kind: edit.NewLayerKind, src?: string): void {
    const artworkId = this.store.artwork()?.id;
    if (!artworkId) return;
    let created = '';
    this.store.edit((c) => {
      const r = edit.addLayer(c, artworkId, kind, { src });
      created = r?.layerId ?? '';
      return r?.config ?? c;
    });
    if (created) {
      this.store.view.set('artwork');
      this.store.select({ kind: 'layer', id: created });
    }
  }

  protected async addFixedImage(file: File): Promise<void> {
    const src = await this.store.uploadImage(file);
    if (src) this.addLayer('fixed-image', src);
  }
}
