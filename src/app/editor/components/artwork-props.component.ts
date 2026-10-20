import { Component, computed, inject } from '@angular/core';
import { Artwork, layerFieldId } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';

/** Inspector for an artwork, including the customer inputs it generates. */
@Component({
  selector: 'app-artwork-props',
  imports: [CONTROLS, SectionComponent],
  template: `
    @if (artwork(); as a) {
      <header class="inspector-head">
        <p class="inspector-kind">Artwork · {{ areaName() }}</p>
        <app-text-in label="Name" [value]="a.name" [maxlength]="80" (changed)="rename($event)" />
      </header>

      <app-section title="Appearance">
        <app-color
          label="Background"
          [allowTransparent]="true"
          [value]="a.background ?? 'transparent'"
          (changed)="setBackground($event)"
        />
        <p class="field-hint">Layers are listed in the Layers tab, front first.</p>
      </app-section>

      <app-section title="Customer inputs from this artwork">
        @if (inputs().length === 0) {
          <p class="field-hint">
            None yet. Add a photo upload or editable text layer and its input appears here and in
            the customer preview automatically.
          </p>
        } @else {
          <ul class="plain-list">
            @for (row of inputs(); track row.layerId) {
              <li class="list-row-simple">
                <button
                  type="button"
                  class="link-btn"
                  (click)="store.select({ kind: 'layer', id: row.layerId })"
                >
                  {{ row.label }}
                </button>
                <span class="field-hint"
                  >{{ row.type }}{{ row.required ? ' · required' : '' }}</span
                >
              </li>
            }
          </ul>
        }
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm" (click)="store.sidebarTab.set('layers')">
          Open layers
        </button>
        <button
          type="button"
          class="btn btn--sm btn--danger"
          [disabled]="!canRemove()"
          (click)="remove(a)"
        >
          Delete…
        </button>
      </div>
    }
  `,
})
export class ArtworkPropsComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);

  protected readonly artwork = computed<Artwork | null>(() => {
    const s = this.store.selection();
    return s.kind === 'artwork'
      ? (this.store.config()?.artworks.find((a) => a.id === s.id) ?? null)
      : null;
  });
  protected readonly areaName = computed(() => {
    const a = this.artwork();
    return this.store.config()?.printableAreas.find((x) => x.id === a?.printableAreaId)?.name ?? '';
  });
  protected readonly inputs = computed(() => {
    const a = this.artwork();
    const c = this.store.config();
    if (!a || !c) return [];
    return a.layers.flatMap((layer) => {
      const fieldId = layerFieldId(layer);
      const field = fieldId ? c.fields.find((f) => f.id === fieldId) : undefined;
      if (!field) return [];
      const type =
        field.type === 'image' ? 'Photo' : field.type === 'text' ? 'Text' : 'Artwork choice';
      return [{ layerId: layer.id, label: field.label, type, required: field.required }];
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

  protected async remove(a: Artwork): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: `Delete “${a.name}”?`,
      message: 'Its layers and the customer inputs only it uses are deleted. You can undo this.',
      confirmLabel: 'Delete artwork',
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeArtwork(c, a.id));
    this.store.select({ kind: 'area', id: a.printableAreaId });
  }
}
