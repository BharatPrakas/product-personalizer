import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
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
  imports: [CONTROLS, SectionComponent, TranslatePipe],
  template: `
    @if (artwork(); as a) {
      <header class="inspector-head">
        <p class="inspector-kind">{{ 'inspector.artwork.kind' | t: { area: areaName() } }}</p>
        <app-text-in
          [label]="'inspector.name' | t"
          [value]="a.name"
          [maxlength]="80"
          (changed)="rename($event)"
        />
      </header>

      <app-section [title]="'inspector.appearance' | t">
        <app-color
          [label]="'inspector.background' | t"
          [allowTransparent]="true"
          [value]="a.background ?? 'transparent'"
          (changed)="setBackground($event)"
        />
        <p class="field-hint">{{ 'inspector.artwork.layers-hint' | t }}</p>
      </app-section>

      <app-section [title]="'inspector.artwork.inputs' | t">
        @if (inputs().length === 0) {
          <p class="field-hint">
            {{ 'inspector.artwork.inputs-none' | t }}
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
                <span class="field-hint">{{ row.meta }}</span>
              </li>
            }
          </ul>
        }
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm" (click)="store.sidebarTab.set('layers')">
          {{ 'inspector.artwork.open-layers' | t }}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--danger"
          [disabled]="!canRemove()"
          (click)="remove(a)"
        >
          {{ 'common.delete-ellipsis' | t }}
        </button>
      </div>
    }
  `,
})
export class ArtworkPropsComponent {
  private readonly i18n = inject(I18n);
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
      const type = this.i18n.t(
        field.type === 'image'
          ? 'inspector.input-type.image'
          : field.type === 'text'
            ? 'inspector.input-type.text'
            : 'inspector.input-type.artwork',
      );
      const meta = field.required
        ? this.i18n.t('inspector.artwork.input-required', { type })
        : type;
      return [{ layerId: layer.id, label: field.label, meta }];
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
      title: this.i18n.t('artworks.delete.title', { name: a.name }),
      message: this.i18n.t('artworks.delete.message'),
      confirmLabel: this.i18n.t('artworks.delete.confirm'),
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeArtwork(c, a.id));
    this.store.select({ kind: 'area', id: a.printableAreaId });
  }
}
