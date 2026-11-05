import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ProductConfig } from '../../customizer/models/product.models';
import { AssetStore } from '../../customizer/services/asset-store.service';
import { CustomerPreviewComponent } from '../../preview/customer-preview.component';
import { relativeTime } from '../../configurations/relative-time';
import { ConfirmService } from '../../ui/confirm.service';
import { AdminHost } from '../../admin/admin-host.service';
import { MarkupLibrary } from '../../markups/markup-library.service';
import { SaveMarkupDialogComponent } from '../../markups/save-markup-dialog.component';
import { FontLibrary } from '../../fonts/font-library.service';
import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { ConfigurationRepository } from '../../workspace/configuration-repository';
import { EmptyStateComponent } from '../../ui/empty-state.component';
import { IconComponent } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { AddAreaDialogComponent } from '../components/add-area-dialog.component';
import { DesignSidebarComponent } from '../components/design-sidebar.component';
import { InspectorComponent } from '../components/inspector.component';
import { WorkspaceComponent } from '../components/workspace.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';

type Mode = 'edit' | 'preview';

/**
 * The merchant editor: design structure on the left, the canvas in the middle, contextual properties
 * on the right, and a customer-preview mode that runs the real storefront on the working draft.
 */
@Component({
  selector: 'app-editor-page',
  imports: [
    RouterLink,
    IconComponent,
    MenuComponent,
    EmptyStateComponent,
    DesignSidebarComponent,
    WorkspaceComponent,
    InspectorComponent,
    AddAreaDialogComponent,
    CustomerPreviewComponent,
    TranslatePipe,
    SaveMarkupDialogComponent,
  ],
  providers: [EditorStore, AssetStore, MarkupLibrary, FontLibrary],
  host: {
    // Shortcuts act only while focus is inside the editor, so an embedded editor never hijacks
    // keys (Ctrl+S, Ctrl+Z ...) meant for the host page.
    '(keydown)': 'onKey($event)',
    '(window:beforeunload)': 'onBeforeUnload($event)',
  },
  template: `
    @if (store.config(); as c) {
      @if (mode() === 'preview' && previewConfig(); as pc) {
        <app-customer-preview
          [config]="pc"
          [sourceLabel]="'editor.preview.source' | t"
          [backLabel]="'editor.preview.back' | t"
          (back)="mode.set('edit')"
        />
      } @else {
        <div class="editor" #editorRoot tabindex="-1">
          <header class="editor-header">
            <a
              class="btn btn--ghost btn--icon"
              routerLink="/configurations"
              [attr.aria-label]="'editor.back' | t"
              [attr.data-tip]="'list.title' | t"
            >
              <app-icon name="arrow-left" />
            </a>
            <div class="title-block">
              <label class="sr-only" for="config-name">{{ 'newconfig.name' | t }}</label>
              <input
                id="config-name"
                class="input input--ghost title-input"
                type="text"
                maxlength="120"
                [value]="c.product.name"
                (input)="rename($any($event.target).value)"
              />
              <div class="title-meta">
                <span class="badge" [class]="'badge ' + statusBadge().cls">{{
                  statusBadge().text
                }}</span>
                <span
                  class="save-status"
                  [class.is-error]="store.saveState() === 'error'"
                  role="status"
                >
                  {{ saveText() }}
                </span>
              </div>
            </div>

            <span class="grow"></span>

            @if (compact()) {
              <button
                type="button"
                class="btn btn--icon"
                [attr.aria-label]="'editor.panel.left' | t"
                [attr.aria-pressed]="leftOpen()"
                (click)="toggleLeft()"
              >
                <app-icon name="panel-left" />
              </button>
              <button
                type="button"
                class="btn btn--icon"
                [attr.aria-label]="'editor.panel.right' | t"
                [attr.aria-pressed]="rightOpen()"
                (click)="toggleRight()"
              >
                <app-icon name="panel-right" />
              </button>
            }
            <div class="row row--tight" role="group" [attr.aria-label]="'editor.history' | t">
              <button
                type="button"
                class="btn btn--icon btn--ghost"
                [attr.aria-label]="'editor.undo' | t"
                [attr.data-tip]="'editor.undo-tip' | t"
                [disabled]="!store.canUndo()"
                (click)="store.undo()"
              >
                <app-icon name="undo" />
              </button>
              <button
                type="button"
                class="btn btn--icon btn--ghost"
                [attr.aria-label]="'editor.redo' | t"
                [attr.data-tip]="'editor.redo-tip' | t"
                [disabled]="!store.canRedo()"
                (click)="store.redo()"
              >
                <app-icon name="redo" />
              </button>
            </div>
            <button
              type="button"
              class="btn"
              [disabled]="!store.previewable()"
              [attr.title]="store.previewable() ? null : ('editor.preview-disabled' | t)"
              (click)="openPreview()"
            >
              <app-icon name="preview" [size]="16" /> {{ 'editor.preview' | t }}
            </button>
            <button
              type="button"
              class="btn"
              [disabled]="!store.dirty() || store.saveState() === 'saving'"
              (click)="save()"
            >
              <app-icon name="save" [size]="16" />
              {{
                (store.saveState() === 'saving' ? 'editor.save.saving' : 'editor.save-draft') | t
              }}
            </button>
            <button
              type="button"
              class="btn btn--primary"
              [disabled]="
                !store.publishable() || store.publishing() || store.saveState() === 'saving'
              "
              [attr.title]="store.publishable() ? null : ('editor.publish-disabled' | t)"
              (click)="publish()"
            >
              {{ (store.publishing() ? 'editor.publishing' : 'editor.publish') | t }}
            </button>
            @if (host.embedded() && store.record()?.published) {
              <a class="btn" [routerLink]="['/mapping', id()]">
                <app-icon name="list" [size]="16" /> {{ 'mapping.action.open' | t }}
              </a>
            }
            <app-menu [label]="'editor.more' | t" icon="more" align="end">
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                (click)="store.exportConfigJson()"
              >
                <app-icon name="file" [size]="16" /> {{ 'editor.export-json' | t }}
              </button>
              <div class="menu-sep"></div>
              <div class="menu-label">{{ 'editor.test-exports' | t }}</div>
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                [disabled]="!store.area()"
                (click)="store.exportAreaPng(store.area()?.id ?? '')"
              >
                <app-icon name="download" [size]="16" />
                <span
                  >{{ 'editor.export-artwork' | t }}<small>{{ store.area()?.name }}</small></span
                >
              </button>
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                [disabled]="c.printableAreas.length === 0"
                (click)="store.exportAllAreaPngs()"
              >
                <app-icon name="download" [size]="16" /> {{ 'editor.export-artwork-all' | t }}
              </button>
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                [disabled]="!store.mockup()"
                (click)="store.exportPreviewPng(store.mockup()?.id ?? '')"
              >
                <app-icon name="download" [size]="16" />
                <span
                  >{{ 'editor.export-preview' | t }}<small>{{ store.mockup()?.name }}</small></span
                >
              </button>
            </app-menu>
          </header>

          @if (store.storageWarning(); as warning) {
            <p class="notice notice--warning editor-notice" role="status">
              <app-icon name="alert" /> {{ warning }}
            </p>
          }

          <div class="editor-body" [class.is-compact]="compact()">
            <aside
              class="sidebar sidebar--left"
              [class.is-open]="!compact() || leftOpen()"
              [attr.aria-label]="'editor.aside.left' | t"
            >
              <app-design-sidebar />
            </aside>
            <section class="workspace" [attr.aria-label]="'editor.canvas' | t">
              <app-workspace />
            </section>
            <aside
              class="sidebar sidebar--right"
              [class.is-open]="!compact() || rightOpen()"
              [attr.aria-label]="'editor.aside.right' | t"
            >
              <app-inspector />
            </aside>
            @if (compact() && (leftOpen() || rightOpen())) {
              <button
                type="button"
                class="scrim"
                [attr.aria-label]="'editor.close-panels' | t"
                (click)="closePanels()"
              ></button>
            }
          </div>
        </div>
        <app-add-area-dialog />
        <app-save-markup-dialog />
      }
    } @else if (missing()) {
      <div class="page">
        <app-empty-state
          icon="alert"
          [title]="'editor.missing.title' | t"
          [description]="'editor.missing.description' | t"
        >
          <a class="btn btn--primary" routerLink="/configurations">{{ 'editor.back' | t }}</a>
        </app-empty-state>
      </div>
    } @else {
      <p class="page muted" role="status">{{ 'editor.opening' | t }}</p>
    }
  `,
})
export class EditorPageComponent {
  readonly id = input.required<string>();
  protected readonly store = inject(EditorStore);
  private readonly router = inject(Router);
  private readonly confirmService = inject(ConfirmService);
  private readonly repository = inject(ConfigurationRepository);
  private readonly i18n = inject(I18n);
  protected readonly host = inject(AdminHost);
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly editorRoot = viewChild<ElementRef<HTMLElement>>('editorRoot');

  protected readonly mode = signal<Mode>('edit');
  protected readonly previewConfig = signal<ProductConfig | null>(null);
  protected readonly missing = signal(false);

  protected readonly compact = signal(false);
  protected readonly leftOpen = signal(false);
  protected readonly rightOpen = signal(false);
  private readonly now = signal(Date.now());

  protected readonly statusBadge = computed(() => {
    const record = this.store.record();
    if (!record?.published) return { text: this.i18n.t('status.draft'), cls: '' };
    return this.store.unpublishedChanges()
      ? { text: this.i18n.t('editor.status.pending'), cls: 'badge--warning' }
      : { text: this.i18n.t('status.published'), cls: 'badge--success' };
  });

  protected readonly saveText = computed(() => {
    switch (this.store.saveState()) {
      case 'saving':
        return this.i18n.t('editor.save.saving');
      case 'error':
        return this.i18n.t(this.store.saveError() ? 'editor.save.not-saved' : 'editor.save.failed');
      default:
        break;
    }
    if (this.store.dirty()) return this.i18n.t('editor.save.unsaved');
    const record = this.store.record();
    return record
      ? this.i18n.t('editor.save.saved', {
          when: relativeTime(record.updatedAt, this.now(), this.i18n),
        })
      : '';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.store.dispose());
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    destroyRef.onDestroy(() => clearInterval(timer));

    // Panels collapse by the width of the editor itself (not the window): it may be embedded in a
    // narrow admin column. ResizeObserver also fires once on observe, which sets the initial value.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) this.onResize(width);
    });
    observer.observe(this.hostRef.nativeElement);
    destroyRef.onDestroy(() => observer.disconnect());

    // A read-only admin shows the customer preview instead of the editor.
    effect(() => {
      if (this.host.readonly()) {
        void this.router.navigate(['/preview', this.id()], {
          queryParams: { draft: 1 },
          replaceUrl: true,
        });
      }
    });

    effect(() => {
      const id = this.id();
      this.mode.set('edit');
      this.missing.set(false);
      void this.store.open(id).then((ok) => {
        this.missing.set(!ok);
        // Focus the editor so its shortcuts work straight away.
        if (ok) setTimeout(() => this.editorRoot()?.nativeElement.focus({ preventScroll: true }));
      });
    });
  }

  // ---- header actions ----------------------------------------------------------------------------

  protected rename(name: string): void {
    if (name.trim()) this.store.edit((c) => edit.patchProduct(c, { name }), 'product-name');
  }

  protected async save(): Promise<void> {
    if (await this.store.saveDraft())
      this.store.notify('info', this.i18n.t('editor.toast.draft-saved'));
  }

  protected async publish(): Promise<void> {
    const c = this.store.config();
    if (!c) return;
    const ok = await this.confirmService.confirm({
      title: this.i18n.t('editor.publish.title'),
      message: this.i18n.t(
        this.store.dirty() ? 'editor.publish.message-dirty' : 'editor.publish.message',
        { note: this.persistenceNote() },
      ),
      confirmLabel: this.i18n.t('editor.publish'),
    });
    if (ok) await this.store.publish();
  }

  /** Honest wording: where the published configuration actually ends up. */
  private persistenceNote(): string {
    return this.repository.storage().kind === 'cloud'
      ? this.i18n.t('editor.publish.note-cloud')
      : this.i18n.t('editor.publish.note-local');
  }

  protected openPreview(): void {
    if (!this.store.previewable()) return;
    this.previewConfig.set(this.store.config());
    this.mode.set('preview');
  }

  // ---- leaving -----------------------------------------------------------------------------------

  /** Route guard: unsaved changes need an explicit decision. */
  confirmLeave(): boolean | Promise<boolean> {
    if (!this.store.dirty()) return true;
    return this.confirmService.confirm({
      title: this.i18n.t('editor.leave.title'),
      message: this.i18n.t('editor.leave.message'),
      confirmLabel: this.i18n.t('editor.leave.confirm'),
      cancelLabel: this.i18n.t('editor.leave.cancel'),
      danger: true,
    });
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.store.dirty()) event.preventDefault();
  }

  // ---- responsive panels --------------------------------------------------------------------------

  protected onResize(width: number): void {
    const compact = width < 1180;
    if (compact !== this.compact()) {
      this.compact.set(compact);
      this.closePanels();
    }
  }

  protected toggleLeft(): void {
    this.leftOpen.update((v) => !v);
    this.rightOpen.set(false);
  }

  protected toggleRight(): void {
    this.rightOpen.update((v) => !v);
    this.leftOpen.set(false);
  }

  protected closePanels(): void {
    this.leftOpen.set(false);
    this.rightOpen.set(false);
  }

  // ---- keyboard ------------------------------------------------------------------------------------

  protected onKey(event: KeyboardEvent): void {
    if (this.mode() !== 'edit' || !this.store.config()) return;
    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      void this.save();
    } else if (mod && !typing && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.store.redo();
      else this.store.undo();
    } else if (mod && !typing && key === 'y') {
      event.preventDefault();
      this.store.redo();
    } else if (!mod && !typing && !event.altKey && key === 'v') {
      this.store.tool.set({ kind: 'select' });
    } else if (!mod && !typing && !event.altKey && key === 'h') {
      this.store.tool.set({ kind: 'pan' });
    }
  }
}
