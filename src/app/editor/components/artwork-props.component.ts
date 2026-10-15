import { Component, computed, inject } from '@angular/core';
import { Artwork, layerFieldId } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';

/** Properties of an artwork, plus the customer inputs it generates (derived from its bound layers). */
@Component({
  selector: 'app-artwork-props',
  imports: [CONTROLS],
  template: `
    @if (artwork(); as a) {
      <section class="ed-group">
        <h3 class="ed-title">Artwork</h3>
        <app-text-in label="Name" [value]="a.name" [maxlength]="80" (changed)="rename($event)" />
        <app-color
          label="Background"
          [allowTransparent]="true"
          [value]="a.background ?? 'transparent'"
          (changed)="setBackground($event)"
        />
        <p class="ed-hint">
          Layers are listed in the left panel, back to front. Their order is their z-order.
        </p>
      </section>

      <section class="ed-group" aria-label="Generated customer inputs">
        <h4 class="ed-subtitle">Customer inputs generated from this artwork</h4>
        @if (inputs().length === 0) {
          <p class="ed-hint">
            None yet. Add an image placeholder or editable text layer and its input appears here and
            in the storefront automatically.
          </p>
        } @else {
          <ul class="ed-list">
            @for (row of inputs(); track row.fieldId) {
              <li class="ed-list-row">
                <button
                  type="button"
                  class="ed-link"
                  (click)="store.select({ kind: 'layer', id: row.layerId })"
                >
                  {{ row.label }}
                </button>
                <span class="ed-hint"
                  >{{ row.type }}{{ row.required ? ', required' : '' }} · layer
                  <code>{{ row.layerId }}</code></span
                >
              </li>
            }
          </ul>
        }
      </section>

      <div class="ed-row ed-actions">
        <button
          type="button"
          class="ed-btn ed-btn-danger"
          [disabled]="!canRemove()"
          (click)="remove(a)"
        >
          Delete artwork
        </button>
      </div>
    }
  `,
})
export class ArtworkPropsComponent {
  protected readonly store = inject(EditorStore);
  protected readonly edit = edit;
  protected readonly artwork = computed<Artwork | null>(() => {
    const s = this.store.selection();
    return s.kind === 'artwork'
      ? (this.store.config()?.artworks.find((a) => a.id === s.id) ?? null)
      : null;
  });
  protected readonly inputs = computed(() => {
    const a = this.artwork();
    const c = this.store.config();
    if (!a || !c) return [];
    return a.layers.flatMap((layer) => {
      const fieldId = layerFieldId(layer);
      const field = fieldId ? c.fields.find((f) => f.id === fieldId) : undefined;
      return field
        ? [
            {
              fieldId: field.id,
              layerId: layer.id,
              label: field.label,
              type: field.type,
              required: field.required,
            },
          ]
        : [];
    });
  });
  protected readonly canRemove = computed(() => {
    const a = this.artwork();
    const area = this.store.config()?.printableAreas.find((x) => x.id === a?.printableAreaId);
    return (area?.artworkIds.length ?? 0) > 1;
  });

  protected rename(name: string): void {
    const a = this.artwork();
    if (a && name) this.store.edit((c) => edit.updateArtwork(c, a.id, { name }), `art:${a.id}`);
  }

  protected setBackground(value: string): void {
    const a = this.artwork();
    if (a) {
      this.store.edit(
        (c) =>
          edit.updateArtwork(c, a.id, { background: value === 'transparent' ? undefined : value }),
        `artbg:${a.id}`,
      );
    }
  }

  protected remove(a: Artwork): void {
    this.store.edit((c) => edit.removeArtwork(c, a.id));
    this.store.select({ kind: 'area', id: a.printableAreaId });
  }
}
