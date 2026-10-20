import { Component, inject } from '@angular/core';
import { Artwork, PrintableArea } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { IconComponent } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';

/** Sidebar tab: the designs of each printable area (an area can offer several for customers to choose from). */
@Component({
  selector: 'app-artworks-tab',
  imports: [IconComponent, MenuComponent],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">Artworks</h2>
    </div>
    @if (store.config(); as c) {
      @if (c.printableAreas.length === 0) {
        <p class="tab-empty">Artwork belongs to a printable area. Add a printable area first.</p>
      }
      @for (a of c.printableAreas; track a.id) {
        <section class="list-group" [attr.aria-label]="a.name + ' artworks'">
          <h3 class="list-group__title truncate">{{ a.name }}</h3>
          <ul class="list">
            @for (art of artworksOf(a); track art.id) {
              <li class="list-row" [class.is-selected]="isSelected(art.id)">
                <button
                  type="button"
                  class="list-row__main"
                  (click)="store.select({ kind: 'artwork', id: art.id })"
                >
                  <span class="list-row__icon"><app-icon name="artwork" [size]="18" /></span>
                  <span class="list-row__text">
                    <span class="list-row__title truncate">{{ art.name }}</span>
                    <span class="list-row__meta truncate">
                      {{ art.layers.length }} {{ art.layers.length === 1 ? 'layer' : 'layers' }}
                      @if (a.artworkIds.length > 1 && art.id === a.artworkId) {
                        · default
                      }
                    </span>
                  </span>
                </button>
                <div class="list-row__actions">
                  <app-menu
                    [label]="'More actions for ' + art.name"
                    icon="more"
                    variant="ghost"
                    align="end"
                  >
                    <button
                      type="button"
                      class="menu-item"
                      role="menuitem"
                      (click)="store.select({ kind: 'artwork', id: art.id })"
                    >
                      <app-icon name="pen" [size]="16" /> Edit artwork
                    </button>
                    <button
                      type="button"
                      class="menu-item"
                      role="menuitem"
                      [disabled]="art.id === a.artworkId"
                      (click)="makeDefault(a, art)"
                    >
                      <app-icon name="check" [size]="16" /> Show by default
                    </button>
                    <div class="menu-sep"></div>
                    <button
                      type="button"
                      class="menu-item menu-item--danger"
                      role="menuitem"
                      [disabled]="a.artworkIds.length <= 1"
                      (click)="remove(art)"
                    >
                      <app-icon name="trash" [size]="16" /> Delete…
                    </button>
                  </app-menu>
                </div>
              </li>
            }
          </ul>
          <button type="button" class="btn btn--ghost btn--sm list-group__add" (click)="add(a)">
            <app-icon name="plus" [size]="16" /> Add another artwork
          </button>
        </section>
      }
    }
  `,
})
export class ArtworksTabComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);

  protected artworksOf(area: PrintableArea): Artwork[] {
    return (this.store.config()?.artworks ?? []).filter((a) => a.printableAreaId === area.id);
  }

  protected isSelected(id: string): boolean {
    const s = this.store.selection();
    return s.kind === 'artwork' && s.id === id;
  }

  protected makeDefault(area: PrintableArea, art: Artwork): void {
    this.store.edit((c) => edit.setDefaultArtwork(c, area.id, art.id));
  }

  protected add(area: PrintableArea): void {
    let created = '';
    this.store.edit((c) => {
      const n = c.artworks.filter((x) => x.printableAreaId === area.id).length + 1;
      const r = edit.addArtwork(c, area.id, `${area.name} design ${n}`);
      created = r.id;
      return r.config;
    });
    if (created) this.store.select({ kind: 'artwork', id: created });
  }

  protected async remove(art: Artwork): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: `Delete “${art.name}”?`,
      message: 'Its layers and the customer inputs only it uses are deleted. You can undo this.',
      confirmLabel: 'Delete artwork',
      danger: true,
    });
    if (ok) {
      this.store.edit((c) => edit.removeArtwork(c, art.id));
      this.store.select({ kind: 'product' });
    }
  }
}
