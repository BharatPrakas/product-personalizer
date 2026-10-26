import { Component, inject } from '@angular/core';
import { PrintableArea } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { AdminHost } from '../../admin/admin-host.service';
import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { MarkupLibrary } from '../../markups/markup-library.service';
import { IconComponent, IconName } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';

/** Sidebar tab: the regions of the product that get printed. */
@Component({
  selector: 'app-areas-tab',
  imports: [IconComponent, MenuComponent, TranslatePipe],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">{{ 'areas.title' | t }}</h2>
      <button
        type="button"
        class="btn btn--sm btn--primary"
        (click)="store.addAreaDialogOpen.set(true)"
      >
        <app-icon name="plus" [size]="16" />
        <span>{{ 'areas.add' | t }}</span>
      </button>
    </div>
    @if (store.config(); as c) {
      @if (c.printableAreas.length === 0) {
        <p class="tab-empty">
          {{ 'areas.empty' | t }}
        </p>
      }
      <ul class="list" [attr.aria-label]="'areas.title' | t">
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
                  {{ meta(a) }}
                </span>
              </span>
            </button>
            <div class="list-row__actions">
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                [attr.aria-label]="
                  (visible(a) ? 'areas.hide-boundary-aria' : 'areas.show-boundary-aria')
                    | t: { name: a.name }
                "
                [attr.aria-pressed]="visible(a)"
                [attr.data-tip]="
                  (visible(a) ? 'areas.boundary-shown' : 'areas.boundary-hidden') | t
                "
                (click)="toggleBoundary(a)"
              >
                <app-icon [name]="visible(a) ? 'eye' : 'eye-off'" [size]="16" />
              </button>
              <app-menu
                [label]="'list.more-actions' | t: { name: a.name }"
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
                  <app-icon name="artwork" [size]="16" /> {{ 'common.edit-artwork' | t }}
                </button>
                <button type="button" class="menu-item" role="menuitem" (click)="toggleEnabled(a)">
                  <app-icon [name]="a.enabled ? 'minus' : 'check'" [size]="16" />
                  {{ (a.enabled ? 'areas.turn-off' : 'areas.turn-on') | t }}
                </button>
                <button type="button" class="menu-item" role="menuitem" (click)="duplicate(a)">
                  <app-icon name="copy" [size]="16" /> {{ 'common.duplicate' | t }}
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  [disabled]="readonly()"
                  (click)="library.requestSaveArea(a)"
                >
                  <app-icon name="shapes" [size]="16" /> {{ 'markups.save-as' | t }}
                </button>
                <div class="menu-sep"></div>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(a)"
                >
                  <app-icon name="trash" [size]="16" /> {{ 'common.delete-ellipsis' | t }}
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
  private readonly i18n = inject(I18n);
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);
  protected readonly library = inject(MarkupLibrary);
  protected readonly readonly = inject(AdminHost).readonly;

  protected isSelected(id: string): boolean {
    const s = this.store.selection();
    return s.kind === 'area' && s.id === id;
  }

  protected icon(a: PrintableArea): IconName {
    return a.shape.type === 'rect' ? 'square' : a.shape.type === 'ellipse' ? 'circle' : 'vector';
  }

  protected meta(a: PrintableArea): string {
    const shape = this.i18n.t(
      a.shape.type === 'rect'
        ? 'shape.rect'
        : a.shape.type === 'ellipse'
          ? 'shape.ellipse'
          : 'shape.custom',
    );
    return this.i18n.t(a.enabled ? 'areas.meta' : 'areas.meta-off', {
      width: a.canvas.width,
      height: a.canvas.height,
      shape,
    });
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
      title: this.i18n.t('areas.delete.title', { name: a.name }),
      message: this.i18n.plural('areas.delete.message', artworks),
      confirmLabel: this.i18n.t('areas.delete.confirm'),
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeArea(c, a.id));
  }
}
