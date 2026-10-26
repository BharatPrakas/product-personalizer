import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
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
  imports: [IconComponent, MenuComponent, MockupThumbComponent, TranslatePipe],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">{{ 'mockups.title' | t }}</h2>
      <label class="btn btn--sm">
        <app-icon name="plus" [size]="16" />
        <span>{{ 'mockups.add' | t }}</span>
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
          {{ 'mockups.empty' | t }}
        </p>
      }
      <ul class="list" [attr.aria-label]="'mockups.title' | t">
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
                  (m.visible === false ? 'mockups.show-aria' : 'mockups.hide-aria')
                    | t: { name: m.name }
                "
                [attr.data-tip]="
                  (m.visible === false ? 'mockups.hidden-tip' : 'mockups.visible-tip') | t
                "
                (click)="toggleVisible(m)"
              >
                <app-icon [name]="m.visible === false ? 'eye-off' : 'eye'" [size]="16" />
              </button>
              <app-menu
                [label]="'list.more-actions' | t: { name: m.name }"
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
                  <app-icon name="pen" [size]="16" /> {{ 'mockups.rename-settings' | t }}
                </button>
                <button type="button" class="menu-item" role="menuitem" (click)="duplicate(m)">
                  <app-icon name="copy" [size]="16" /> {{ 'common.duplicate' | t }}
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  [disabled]="first"
                  (click)="move(m, -1)"
                >
                  <app-icon name="arrow-up" [size]="16" /> {{ 'common.move-earlier' | t }}
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  [disabled]="last"
                  (click)="move(m, 1)"
                >
                  <app-icon name="arrow-down" [size]="16" /> {{ 'common.move-later' | t }}
                </button>
                <div class="menu-sep"></div>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(m)"
                >
                  <app-icon name="trash" [size]="16" /> {{ 'common.remove-ellipsis' | t }}
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
  private readonly i18n = inject(I18n);
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
        ? this.i18n.t('mockups.no-variant')
        : variants.length === c?.variants.length && variants.length > 1
          ? this.i18n.t('mockups.all-variants')
          : variants.map((v) => v.label).join(', ');
    return this.i18n.t('mockups.meta', {
      areas: this.i18n.plural('mockups.areas', m.placements.length),
      where,
    });
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
      title: this.i18n.t('mockups.remove.title', { name: m.name }),
      message: this.i18n.t(
        m.placements.length > 0 ? 'mockups.remove.message-placements' : 'mockups.remove.message',
      ),
      confirmLabel: this.i18n.t('mockups.remove.confirm'),
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeMockup(c, m.id));
  }
}
