import { Component, inject, signal } from '@angular/core';
import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { AdminHost } from '../../admin/admin-host.service';
import { MAX_FONT_BYTES, type CustomFont } from '../../fonts/font.models';
import { FontLibrary } from '../../fonts/font-library.service';
import { ConfirmService } from '../../ui/confirm.service';
import { DialogComponent } from '../../ui/dialog.component';
import { IconComponent } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { EditorStore } from '../services/editor-store.service';

const FONT_EXTENSIONS = /\.(woff2|woff|ttf|otf)$/i;

function labelFromFilename(name: string): string {
  const words = name.replace(FONT_EXTENSIONS, '').replace(/[_-]+/g, ' ').trim();
  return words ? words.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1)) : 'Custom font';
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Sidebar tab: the template's default fonts (read-only) and the store's custom font library. */
@Component({
  selector: 'app-fonts-tab',
  imports: [IconComponent, MenuComponent, DialogComponent, TranslatePipe],
  template: `
    <div class="tab-head">
      <h2 class="tab-title">{{ 'fonts.title' | t }}</h2>
    </div>
    <p class="tab-empty">{{ 'fonts.lead' | t }}</p>

    <h3 class="list-section-title">{{ 'fonts.default.title' | t }}</h3>
    <p class="list-section-hint">{{ 'fonts.default.lead' | t }}</p>
    <ul class="list" [attr.aria-label]="'fonts.default.title' | t">
      @for (f of defaultFonts(); track f.id) {
        <li class="list-row">
          <div class="list-row__main">
            <span class="list-row__icon"><app-icon name="text" [size]="18" /></span>
            <span class="list-row__text">
              <span class="list-row__title truncate">{{ f.label || f.family }}</span>
            </span>
          </div>
        </li>
      }
    </ul>

    <div class="tab-head">
      <h3 class="list-section-title">{{ 'fonts.custom.title' | t }}</h3>
      <label class="btn btn--sm" [class.is-disabled]="readonly() || library.uploading()">
        <app-icon name="upload" [size]="16" />
        <span>{{ library.uploading() ? ('fonts.uploading' | t) : ('fonts.upload' | t) }}</span>
        <input
          class="sr-only"
          type="file"
          accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf,font/sfnt"
          [disabled]="readonly() || library.uploading()"
          (change)="onFile($event)"
        />
      </label>
    </div>

    @if (library.state() === 'loading') {
      <p class="tab-empty" role="status">{{ 'common.loading' | t }}</p>
    } @else if (library.state() === 'error') {
      <p class="tab-empty" role="alert">
        {{ 'mapping.error.load' | t }}
        <button type="button" class="btn btn--sm" (click)="library.refresh()">
          {{ 'common.retry' | t }}
        </button>
      </p>
    } @else if (library.items().length === 0) {
      <p class="tab-empty">{{ 'fonts.empty' | t }}</p>
    } @else {
      <ul class="list" [attr.aria-label]="'fonts.custom.title' | t">
        @for (f of library.items(); track f.id) {
          <li class="list-row">
            <div class="list-row__main">
              <span class="list-row__icon"><app-icon name="text" [size]="18" /></span>
              <span class="list-row__text">
                <span class="list-row__title truncate">{{ f.label }}</span>
                <span class="list-row__meta truncate">{{ meta(f) }}</span>
              </span>
            </div>
            <div class="list-row__actions">
              @if (library.usedInTemplate(f)) {
                <span class="chip">{{ 'fonts.in-template' | t }}</span>
                <button
                  type="button"
                  class="btn btn--sm"
                  [disabled]="readonly()"
                  (click)="library.removeFromTemplate(f)"
                >
                  {{ 'fonts.remove' | t }}
                </button>
              } @else {
                <button
                  type="button"
                  class="btn btn--sm"
                  [disabled]="readonly()"
                  (click)="library.addToTemplate(f)"
                >
                  <app-icon name="plus" [size]="16" /> {{ 'fonts.add' | t }}
                </button>
              }
              <app-menu
                [label]="'list.more-actions' | t: { name: f.label }"
                icon="more"
                variant="ghost"
                align="end"
                [disabled]="readonly()"
              >
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(f)"
                >
                  <app-icon name="trash" [size]="16" /> {{ 'fonts.delete' | t }}
                </button>
              </app-menu>
            </div>
          </li>
        }
      </ul>
    }

    <app-dialog
      [open]="pendingFile() !== null"
      [title]="'fonts.upload' | t"
      [width]="420"
      (closed)="cancelUpload()"
    >
      <form id="upload-font-form" (submit)="submitUpload($event)">
        <label class="field">
          <span class="label">{{ 'fonts.name' | t }}</span>
          <input
            class="input"
            type="text"
            maxlength="80"
            required
            [placeholder]="'fonts.name-placeholder' | t"
            [value]="label()"
            (input)="label.set($any($event.target).value)"
          />
        </label>
        <p class="field-hint">{{ 'fonts.file-hint' | t }}</p>
        @if (uploadError()) {
          <p class="field-error" role="alert">{{ uploadError() }}</p>
        }
      </form>
      <ng-container dialogActions>
        <button type="button" class="btn" (click)="cancelUpload()">{{ 'common.cancel' | t }}</button>
        <button type="submit" form="upload-font-form" class="btn btn--primary" [disabled]="library.uploading()">
          {{ 'fonts.upload' | t }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class FontsTabComponent {
  protected readonly store = inject(EditorStore);
  protected readonly library = inject(FontLibrary);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18n);
  protected readonly readonly = inject(AdminHost).readonly;

  protected readonly pendingFile = signal<File | null>(null);
  protected readonly label = signal('');
  protected readonly uploadError = signal('');

  /** The template's own fonts that are NOT in the store's custom library: the bundled defaults. */
  protected readonly defaultFonts = () => {
    const customIds = new Set(this.library.items().map((f) => f.id));
    return (this.store.config()?.fonts ?? []).filter((f) => !customIds.has(f.id));
  };

  constructor() {
    void this.library.refresh();
  }

  protected meta(f: CustomFont): string {
    return formatSize(f.sizeBytes);
  }

  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size === 0 || file.size > MAX_FONT_BYTES) {
      this.uploadError.set(this.i18n.t('fonts.error.upload'));
    }
    this.uploadError.set('');
    this.label.set(labelFromFilename(file.name));
    this.pendingFile.set(file);
  }

  protected async submitUpload(event: Event): Promise<void> {
    event.preventDefault();
    const file = this.pendingFile();
    if (!file) return;
    this.uploadError.set('');
    try {
      await this.library.upload(file, this.label());
      this.pendingFile.set(null);
    } catch (error) {
      this.uploadError.set(error instanceof Error ? error.message : this.i18n.t('fonts.error.upload'));
    }
  }

  protected cancelUpload(): void {
    this.pendingFile.set(null);
    this.uploadError.set('');
  }

  protected async remove(f: CustomFont): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.i18n.t('fonts.delete'),
      message: this.i18n.t('fonts.confirm-delete', { name: f.label }),
      confirmLabel: this.i18n.t('fonts.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.library.remove(f);
    } catch {
      /* the library already reported it */
    }
  }
}
