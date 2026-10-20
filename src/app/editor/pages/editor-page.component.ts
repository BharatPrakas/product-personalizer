import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ProductConfig } from '../../customizer/models/product.models';
import { AssetStore } from '../../customizer/services/asset-store.service';
import { CustomerPreviewComponent } from '../../preview/customer-preview.component';
import { relativeTime } from '../../configurations/relative-time';
import { ConfirmService } from '../../ui/confirm.service';
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
  ],
  providers: [EditorStore, AssetStore],
  host: {
    '(window:keydown)': 'onKey($event)',
    '(window:beforeunload)': 'onBeforeUnload($event)',
    '(window:resize)': 'onResize()',
  },
  template: `
    @if (store.config(); as c) {
      @if (mode() === 'preview' && previewConfig(); as pc) {
        <app-customer-preview
          [config]="pc"
          sourceLabel="Working draft, including unsaved changes"
          backLabel="Back to editor"
          (back)="mode.set('edit')"
        />
      } @else {
        <div class="editor">
          <header class="editor-header">
            <a
              class="btn btn--ghost btn--icon"
              routerLink="/configurations"
              aria-label="Back to configurations"
              data-tip="Configurations"
            >
              <app-icon name="arrow-left" />
            </a>
            <div class="title-block">
              <label class="sr-only" for="config-name">Configuration name</label>
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
                aria-label="Toggle design structure panel"
                [attr.aria-pressed]="leftOpen()"
                (click)="toggleLeft()"
              >
                <app-icon name="panel-left" />
              </button>
              <button
                type="button"
                class="btn btn--icon"
                aria-label="Toggle properties panel"
                [attr.aria-pressed]="rightOpen()"
                (click)="toggleRight()"
              >
                <app-icon name="panel-right" />
              </button>
            }
            <div class="row row--tight" role="group" aria-label="History">
              <button
                type="button"
                class="btn btn--icon btn--ghost"
                aria-label="Undo"
                data-tip="Undo (Ctrl+Z)"
                [disabled]="!store.canUndo()"
                (click)="store.undo()"
              >
                <app-icon name="undo" />
              </button>
              <button
                type="button"
                class="btn btn--icon btn--ghost"
                aria-label="Redo"
                data-tip="Redo (Ctrl+Shift+Z)"
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
              [attr.title]="
                store.previewable() ? null : 'Finish the setup to preview this configuration'
              "
              (click)="openPreview()"
            >
              <app-icon name="preview" [size]="16" /> Preview
            </button>
            <button
              type="button"
              class="btn"
              [disabled]="!store.dirty() || store.saveState() === 'saving'"
              (click)="save()"
            >
              <app-icon name="save" [size]="16" />
              {{ store.saveState() === 'saving' ? 'Saving…' : 'Save draft' }}
            </button>
            <button
              type="button"
              class="btn btn--primary"
              [disabled]="
                !store.publishable() || store.publishing() || store.saveState() === 'saving'
              "
              [attr.title]="store.publishable() ? null : 'Complete the setup steps to publish'"
              (click)="publish()"
            >
              {{ store.publishing() ? 'Publishing…' : 'Publish' }}
            </button>
            <app-menu label="More actions" icon="more" align="end">
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                (click)="store.exportConfigJson()"
              >
                <app-icon name="file" [size]="16" /> Export configuration (JSON)
              </button>
              <div class="menu-sep"></div>
              <div class="menu-label">Test exports from the current design</div>
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                [disabled]="!store.area()"
                (click)="store.exportAreaPng(store.area()?.id ?? '')"
              >
                <app-icon name="download" [size]="16" />
                <span
                  >Artwork PNG<small>{{ store.area()?.name }}</small></span
                >
              </button>
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                [disabled]="c.printableAreas.length === 0"
                (click)="store.exportAllAreaPngs()"
              >
                <app-icon name="download" [size]="16" /> Artwork PNG for every area
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
                  >Product preview PNG<small>{{ store.mockup()?.name }}</small></span
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
              aria-label="Design structure"
            >
              <app-design-sidebar />
            </aside>
            <main class="workspace" aria-label="Canvas workspace">
              <app-workspace />
            </main>
            <aside
              class="sidebar sidebar--right"
              [class.is-open]="!compact() || rightOpen()"
              aria-label="Properties"
            >
              <app-inspector />
            </aside>
            @if (compact() && (leftOpen() || rightOpen())) {
              <button
                type="button"
                class="scrim"
                aria-label="Close panels"
                (click)="closePanels()"
              ></button>
            }
          </div>
        </div>
        <app-add-area-dialog />
      }
    } @else if (missing()) {
      <div class="page">
        <app-empty-state
          icon="alert"
          title="Configuration not found"
          description="It may have been deleted, or it belongs to another browser profile."
        >
          <a class="btn btn--primary" routerLink="/configurations">Back to configurations</a>
        </app-empty-state>
      </div>
    } @else {
      <p class="page muted" role="status">Opening the editor…</p>
    }
  `,
})
export class EditorPageComponent {
  readonly id = input.required<string>();
  protected readonly store = inject(EditorStore);
  private readonly router = inject(Router);
  private readonly confirmService = inject(ConfirmService);

  protected readonly mode = signal<Mode>('edit');
  protected readonly previewConfig = signal<ProductConfig | null>(null);
  protected readonly missing = signal(false);

  protected readonly compact = signal(window.innerWidth < 1180);
  protected readonly leftOpen = signal(false);
  protected readonly rightOpen = signal(false);
  private readonly now = signal(Date.now());

  protected readonly statusBadge = computed(() => {
    const record = this.store.record();
    if (!record?.published) return { text: 'Draft', cls: '' };
    return this.store.unpublishedChanges()
      ? { text: 'Published · changes pending', cls: 'badge--warning' }
      : { text: 'Published', cls: 'badge--success' };
  });

  protected readonly saveText = computed(() => {
    switch (this.store.saveState()) {
      case 'saving':
        return 'Saving…';
      case 'error':
        return this.store.saveError() ? 'Not saved' : 'Save failed';
      default:
        break;
    }
    if (this.store.dirty()) return 'Unsaved changes';
    const record = this.store.record();
    return record ? `Saved ${relativeTime(record.updatedAt, this.now())}` : '';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.store.dispose());
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    destroyRef.onDestroy(() => clearInterval(timer));

    effect(() => {
      const id = this.id();
      this.mode.set('edit');
      this.missing.set(false);
      void this.store.open(id).then((ok) => this.missing.set(!ok));
    });
  }

  // ---- header actions ----------------------------------------------------------------------------

  protected rename(name: string): void {
    if (name.trim()) this.store.edit((c) => edit.patchProduct(c, { name }), 'product-name');
  }

  protected async save(): Promise<void> {
    if (await this.store.saveDraft()) this.store.notify('info', 'Draft saved.');
  }

  protected async publish(): Promise<void> {
    const c = this.store.config();
    if (!c) return;
    const ok = await this.confirmService.confirm({
      title: 'Publish this configuration?',
      message: this.store.dirty()
        ? 'Your unsaved changes are saved first. Publishing makes the current design the published configuration and keeps the draft open for further edits. It is stored in this browser; nothing is sent to a server.'
        : 'Publishing makes the current design the published configuration and keeps the draft open for further edits. It is stored in this browser; nothing is sent to a server.',
      confirmLabel: 'Publish',
    });
    if (ok) await this.store.publish();
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
      title: 'Leave without saving?',
      message: 'You have unsaved changes to this configuration. They will be lost.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    });
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.store.dirty()) event.preventDefault();
  }

  // ---- responsive panels --------------------------------------------------------------------------

  protected onResize(): void {
    const compact = window.innerWidth < 1180;
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
