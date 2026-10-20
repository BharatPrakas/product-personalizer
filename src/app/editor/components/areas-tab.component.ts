import { Component, inject } from '@angular/core';
import { PrintableArea } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { IconComponent, IconName } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';

/** Sidebar tab: the regions of the product that get printed. */
@Component({
  selector: 'app-areas-tab',
  imports: [IconComponent, MenuComponent],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">Printable areas</h2>
      <button
        type="button"
        class="btn btn--sm btn--primary"
        (click)="store.addAreaDialogOpen.set(true)"
      >
        <app-icon name="plus" [size]="16" />
        <span>Add area</span>
      </button>
    </div>
    @if (store.config(); as c) {
      @if (c.printableAreas.length === 0) {
        <p class="tab-empty">
          A printable area is the region of the product that gets printed. Draw one on a mockup to
          start designing its artwork.
        </p>
      }
      <ul class="list" aria-label="Printable areas">
        @for (a of c.printableAreas; track a.id) {
          <li class="list-row" [class.is-selected]="isSelected(a.id)">
            <button
              type="button"
              class="list-row__main"
              (click)="store.select({ kind: 'area', id: a.id })"
            >
              <span class="list-row__icon"><app-icon [name]="icon(a)" [size]="18" /></span>
              <span class="list-row__text">
                <span class="list-row__title truncate" [class.is-muted]="!a.enabled">{{
                  a.name
                }}</span>
                <span class="list-row__meta truncate">
                  {{ a.canvas.width }} × {{ a.canvas.height }} px · {{ shapeLabel(a)
                  }}{{ a.enabled ? '' : ' · off' }}
                </span>
              </span>
            </button>
            <div class="list-row__actions">
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                [attr.aria-label]="
                  (visible(a) ? 'Hide boundary of ' : 'Show boundary of ') + a.name
                "
                [attr.aria-pressed]="visible(a)"
                [attr.data-tip]="visible(a) ? 'Boundary shown on mockups' : 'Boundary hidden'"
                (click)="toggleBoundary(a)"
              >
                <app-icon [name]="visible(a) ? 'eye' : 'eye-off'" [size]="16" />
              </button>
              <app-menu
                [label]="'More actions for ' + a.name"
                icon="more"
                variant="ghost"
                align="end"
              >
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  (click)="store.editArea(a.id)"
                >
                  <app-icon name="artwork" [size]="16" /> Edit artwork
                </button>
                <button type="button" class="menu-item" role="menuitem" (click)="toggleEnabled(a)">
                  <app-icon [name]="a.enabled ? 'minus' : 'check'" [size]="16" />
                  {{ a.enabled ? 'Turn off' : 'Turn on' }}
                </button>
                <button type="button" class="menu-item" role="menuitem" (click)="duplicate(a)">
                  <app-icon name="copy" [size]="16" /> Duplicate
                </button>
                <div class="menu-sep"></div>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(a)"
                >
                  <app-icon name="trash" [size]="16" /> Delete…
                </button>
              </app-menu>
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class AreasTabComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);

  protected isSelected(id: string): boolean {
    const s = this.store.selection();
    return s.kind === 'area' && s.id === id;
  }

  protected icon(a: PrintableArea): IconName {
    return a.shape.type === 'rect' ? 'square' : a.shape.type === 'ellipse' ? 'circle' : 'vector';
  }

  protected shapeLabel(a: PrintableArea): string {
    return a.shape.type === 'rect'
      ? 'rectangle'
      : a.shape.type === 'ellipse'
        ? 'ellipse'
        : 'custom shape';
  }

  protected visible(a: PrintableArea): boolean {
    return a.boundary?.visible !== false;
  }

  protected toggleBoundary(a: PrintableArea): void {
    this.store.edit((c) =>
      edit.updateArea(c, a.id, {
        boundary: { color: '#e11d48', opacity: 0.85, ...a.boundary, visible: !this.visible(a) },
      }),
    );
  }

  protected toggleEnabled(a: PrintableArea): void {
    this.store.edit((c) => edit.updateArea(c, a.id, { enabled: !a.enabled }));
  }

  protected duplicate(a: PrintableArea): void {
    let created = '';
    this.store.edit((c) => {
      const r = edit.duplicateArea(c, a.id);
      created = r?.areaId ?? '';
      return r?.config ?? c;
    });
    if (created) this.store.select({ kind: 'area', id: created });
  }

  protected async remove(a: PrintableArea): Promise<void> {
    const artworks =
      this.store.config()?.artworks.filter((x) => x.printableAreaId === a.id).length ?? 0;
    const ok = await this.confirmService.confirm({
      title: `Delete “${a.name}”?`,
      message: `The area, its ${artworks} ${artworks === 1 ? 'artwork' : 'artworks'}, their layers and customer inputs, and its placements on every mockup are deleted. You can undo this.`,
      confirmLabel: 'Delete area',
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeArea(c, a.id));
  }
}
