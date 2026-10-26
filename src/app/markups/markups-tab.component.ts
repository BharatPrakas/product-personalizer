import { Component, effect, inject, signal, untracked } from '@angular/core';
import { AdminHost } from '../admin/admin-host.service';
import { I18n, TranslatePipe } from '../admin/i18n/i18n.service';
import { ConfirmService } from '../ui/confirm.service';
import { DialogComponent } from '../ui/dialog.component';
import { IconComponent } from '../ui/icon.component';
import { MenuComponent } from '../ui/menu.component';
import { Markup, MarkupInvalidError, MarkupKind, MarkupNameTakenError } from './markup.models';
import { MarkupLibrary } from './markup-library.service';

/** Sidebar tab: the reusable areas and artworks, searchable, with copy-on-insert. */
@Component({
  selector: 'app-markups-tab',
  imports: [IconComponent, MenuComponent, DialogComponent, TranslatePipe],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">{{ 'markups.title' | t }}</h2>
    </div>
    <p class="tab-empty">{{ 'markups.lead' | t }}</p>
    <div class="segmented markup-kinds" role="group" [attr.aria-label]="'markups.title' | t">
      @for (k of kinds; track k) {
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="kind() === k"
          (click)="kind.set(k)"
        >
          {{ k === 'area' ? ('markups.kind.area' | t) : ('markups.kind.artwork' | t) }}
        </button>
      }
    </div>
    <label class="search markup-search">
      <app-icon name="search" />
      <span class="sr-only">{{ 'markups.search' | t }}</span>
      <input
        class="input"
        type="search"
        [placeholder]="'markups.search' | t"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
    </label>

    @if (library.state() === 'loading') {
      <p class="tab-empty" role="status">{{ 'common.loading' | t }}</p>
    } @else if (library.state() === 'error') {
      <p class="tab-empty" role="alert">
        {{ 'mapping.error.load' | t }}
        <button type="button" class="btn btn--sm" (click)="reload()">
          {{ 'common.retry' | t }}
        </button>
      </p>
    } @else if (library.items().length === 0) {
      <p class="tab-empty">{{ 'markups.empty' | t }}</p>
    } @else {
      <ul class="list" [attr.aria-label]="'markups.title' | t">
        @for (m of library.items(); track m.id) {
          <li class="list-row">
            <div class="list-row__main">
              <span class="list-row__icon"
                ><app-icon [name]="m.kind === 'area' ? 'area' : 'artwork'" [size]="18"
              /></span>
              <span class="list-row__text">
                <span class="list-row__title truncate">{{ m.name }}</span>
                <span class="list-row__meta truncate">{{ meta(m) }}</span>
              </span>
            </div>
            <div class="list-row__actions">
              <button
                type="button"
                class="btn btn--sm"
                [disabled]="readonly()"
                (click)="library.insert(m)"
              >
                <app-icon name="plus" [size]="16" /> {{ 'markups.insert' | t }}
                <span class="sr-only">{{ m.name }}</span>
              </button>
              <app-menu
                [label]="'More actions for ' + m.name"
                icon="more"
                variant="ghost"
                align="end"
                [disabled]="readonly()"
              >
                <button type="button" class="menu-item" role="menuitem" (click)="startRename(m)">
                  <app-icon name="pen" [size]="16" /> {{ 'markups.rename' | t }}
                </button>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(m)"
                >
                  <app-icon name="trash" [size]="16" /> {{ 'markups.delete' | t }}
                </button>
              </app-menu>
            </div>
          </li>
        }
      </ul>
    }

    <app-dialog
      [open]="renaming() !== null"
      [title]="'markups.rename' | t"
      [width]="420"
      (closed)="renaming.set(null)"
    >
      <form id="rename-markup-form" (submit)="submitRename($event)">
        <label class="field">
          <span class="label">{{ 'markups.name' | t }}</span>
          <input
            class="input"
            type="text"
            maxlength="120"
            required
            [value]="newName()"
            (input)="newName.set($any($event.target).value)"
          />
        </label>
        @if (renameError()) {
          <p class="field-error" role="alert">{{ renameError() }}</p>
        }
      </form>
      <ng-container dialogActions>
        <button type="button" class="btn" (click)="renaming.set(null)">
          {{ 'common.cancel' | t }}
        </button>
        <button type="submit" form="rename-markup-form" class="btn btn--primary">
          {{ 'common.save' | t }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class MarkupsTabComponent {
  protected readonly library = inject(MarkupLibrary);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18n);
  protected readonly readonly = inject(AdminHost).readonly;

  protected readonly kinds: MarkupKind[] = ['area', 'artwork'];
  protected readonly kind = signal<MarkupKind>('area');
  protected readonly query = signal('');
  protected readonly renaming = signal<Markup | null>(null);
  protected readonly newName = signal('');
  protected readonly renameError = signal('');

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.kind();
      this.query();
      untracked(() => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reload(), 200);
      });
    });
    // After saving a markup from another tab the list is stale; refresh when the dialog closes.
    effect(() => {
      if (this.library.saveRequest() === null) untracked(() => this.reload());
    });
  }

  protected reload(): void {
    void this.library.refresh({ kind: this.kind(), search: this.query() });
  }

  protected meta(m: Markup): string {
    const p = m.payload;
    if (p.kind === 'area') return `${p.area.canvas.width} × ${p.area.canvas.height} px`;
    return `${p.artwork.layers.length} ${p.artwork.layers.length === 1 ? 'layer' : 'layers'}`;
  }

  protected startRename(m: Markup): void {
    this.renameError.set('');
    this.newName.set(m.name);
    this.renaming.set(m);
  }

  protected async submitRename(event: Event): Promise<void> {
    event.preventDefault();
    const target = this.renaming();
    if (!target) return;
    try {
      await this.library.rename(target, this.newName());
      this.renaming.set(null);
      this.reload();
    } catch (error) {
      this.renameError.set(
        error instanceof MarkupNameTakenError
          ? this.i18n.t('markups.name-taken')
          : error instanceof MarkupInvalidError
            ? error.message
            : this.i18n.t('markups.error'),
      );
    }
  }

  protected async remove(m: Markup): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.i18n.t('markups.delete'),
      message: this.i18n.t('markups.confirm-delete', { name: m.name }),
      confirmLabel: this.i18n.t('markups.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.library.remove(m);
      this.reload();
    } catch {
      /* the repository already reported it */
    }
  }
}
