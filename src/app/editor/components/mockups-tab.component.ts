import { Component, inject } from '@angular/core';
import { IconComponent } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { ConfirmService } from '../../ui/confirm.service';
import { ProductMockup } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { MockupThumbComponent } from './mockup-thumb.component';

/** Sidebar tab: the product photos customers see their design on. */
@Component({
  selector: 'app-mockups-tab',
  imports: [IconComponent, MenuComponent, MockupThumbComponent],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">Mockups</h2>
      <label class="btn btn--sm">
        <app-icon name="plus" [size]="16" />
        <span>Add mockup</span>
        <input
          class="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          (change)="onFile($event)"
        />
      </label>
    </div>
    @if (store.config(); as c) {
      @if (c.mockups.length === 0) {
        <p class="tab-empty">
          Add the product photo customers will see their personalized design on. Printable areas are
          placed on top of it.
        </p>
      }
      <ul class="list" aria-label="Mockups">
        @for (m of c.mockups; track m.id; let first = $first; let last = $last) {
          <li class="list-row" [class.is-selected]="isSelected(m.id)">
            <button
              type="button"
              class="list-row__main"
              (click)="store.select({ kind: 'mockup', id: m.id })"
            >
              <app-mockup-thumb [mockupId]="m.id" />
              <span class="list-row__text">
                <span class="list-row__title truncate" [class.is-muted]="m.visible === false">{{
                  m.name
                }}</span>
                <span class="list-row__meta truncate">{{ meta(m) }}</span>
              </span>
            </button>
            <div class="list-row__actions">
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                [attr.aria-label]="
                  (m.visible === false ? 'Show ' : 'Hide ') + m.name + ' to customers'
                "
                [attr.data-tip]="
                  m.visible === false ? 'Hidden from customers' : 'Visible to customers'
                "
                (click)="toggleVisible(m)"
              >
                <app-icon [name]="m.visible === false ? 'eye-off' : 'eye'" [size]="16" />
              </button>
              <app-menu
                [label]="'More actions for ' + m.name"
                icon="more"
                variant="ghost"
                align="end"
              >
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  (click)="store.select({ kind: 'mockup', id: m.id })"
                >
                  <app-icon name="pen" [size]="16" /> Rename and settings
                </button>
                <button type="button" class="menu-item" role="menuitem" (click)="duplicate(m)">
                  <app-icon name="copy" [size]="16" /> Duplicate
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  [disabled]="first"
                  (click)="move(m, -1)"
                >
                  <app-icon name="arrow-up" [size]="16" /> Move earlier
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  [disabled]="last"
                  (click)="move(m, 1)"
                >
                  <app-icon name="arrow-down" [size]="16" /> Move later
                </button>
                <div class="menu-sep"></div>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(m)"
                >
                  <app-icon name="trash" [size]="16" /> Remove…
                </button>
              </app-menu>
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class MockupsTabComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);

  protected isSelected(id: string): boolean {
    const s = this.store.selection();
    return s.kind === 'mockup' && s.id === id;
  }

  protected meta(m: ProductMockup): string {
    const c = this.store.config();
    const variants = (c?.variants ?? []).filter((v) => v.mockupIds.includes(m.id));
    const where =
      variants.length === 0
        ? 'No variant'
        : variants.length === c?.variants.length && variants.length > 1
          ? 'All variants'
          : variants.map((v) => v.label).join(', ');
    return `${m.placements.length} ${m.placements.length === 1 ? 'area' : 'areas'} · ${where}`;
  }

  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.store.addMockupFromFile(file);
  }

  protected toggleVisible(m: ProductMockup): void {
    this.store.edit((c) =>
      edit.updateMockup(c, m.id, { visible: m.visible === false ? undefined : false }),
    );
  }

  protected move(m: ProductMockup, direction: -1 | 1): void {
    this.store.edit((c) => edit.moveMockup(c, m.id, direction));
  }

  protected duplicate(m: ProductMockup): void {
    let created = '';
    this.store.edit((c) => {
      const r = edit.duplicateMockup(c, m.id);
      created = r?.id ?? '';
      return r?.config ?? c;
    });
    if (created) this.store.select({ kind: 'mockup', id: created });
  }

  protected async remove(m: ProductMockup): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: `Remove “${m.name}”?`,
      message:
        m.placements.length > 0
          ? 'Its printable-area placements are removed with it. The printable areas and their artwork are kept. You can undo this.'
          : 'You can undo this.',
      confirmLabel: 'Remove mockup',
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeMockup(c, m.id));
  }
}
