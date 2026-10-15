import {
  Component,
  DestroyRef,
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
import { CONTROLS } from '../components/controls.component';
import { PropertiesPanelComponent } from '../components/properties-panel.component';
import { StageComponent } from '../components/stage.component';
import { StorefrontHostComponent } from '../components/storefront-host.component';
import { StructurePanelComponent } from '../components/structure-panel.component';
import { ConfigRepository } from '../services/config-repository.service';
import { EditorStore } from '../services/editor-store.service';

type Mode = 'configure' | 'preview';

/**
 * The merchant editor: structure on the left, the interactive canvas in the middle, properties on
 * the right, and a "Customer preview" mode that runs the real storefront on the configuration.
 */
@Component({
  selector: 'app-editor-page',
  imports: [
    RouterLink,
    StructurePanelComponent,
    StageComponent,
    PropertiesPanelComponent,
    StorefrontHostComponent,
    CONTROLS,
  ],
  providers: [EditorStore, AssetStore],
  host: { '(window:keydown)': 'onKey($event)', '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    @if (store.config(); as c) {
      <div class="ed-shell">
        <header class="ed-topbar">
          <a class="ed-btn" routerLink="/" (click)="leave($event)">← Products</a>
          <h1 class="ed-product-name">{{ c.product.name }}</h1>
          <span class="ed-badge">{{ c.status }}</span>
          @if (store.dirty()) {
            <span class="ed-dirty" role="status">Unsaved changes</span>
          }
          <span class="ed-grow"></span>
          <button
            type="button"
            class="ed-btn"
            [disabled]="!store.canUndo()"
            (click)="store.undo()"
            aria-keyshortcuts="Control+Z"
          >
            Undo
          </button>
          <button
            type="button"
            class="ed-btn"
            [disabled]="!store.canRedo()"
            (click)="store.redo()"
            aria-keyshortcuts="Control+Shift+Z"
          >
            Redo
          </button>
          <button
            type="button"
            class="ed-btn ed-btn-primary"
            (click)="store.save()"
            aria-keyshortcuts="Control+S"
          >
            Save
          </button>
          @if (mode() === 'configure') {
            <button type="button" class="ed-btn" (click)="openPreview()">
              Preview as customer
            </button>
          } @else {
            <button type="button" class="ed-btn" (click)="mode.set('configure')">
              Back to editing
            </button>
          }
          <details class="ed-menu">
            <summary class="ed-btn">Export</summary>
            <div class="ed-menu-body" role="menu">
              <button type="button" role="menuitem" (click)="store.exportConfigJson()">
                Configuration JSON
              </button>
              <button
                type="button"
                role="menuitem"
                (click)="store.exportAreaPng(store.area()?.id ?? '')"
              >
                Artwork PNG: {{ store.area()?.name }}
              </button>
              <button type="button" role="menuitem" (click)="store.exportAllAreaPngs()">
                Artwork PNG: every area
              </button>
              <button
                type="button"
                role="menuitem"
                (click)="store.exportPreviewPng(store.mockup()?.id ?? '')"
              >
                Preview PNG: {{ store.mockup()?.name }}
              </button>
            </div>
          </details>
          <details class="ed-menu">
            <summary class="ed-btn">More</summary>
            <div class="ed-menu-body" role="menu">
              <button
                type="button"
                role="menuitem"
                [disabled]="!store.sample()"
                (click)="store.restoreSample()"
              >
                Restore sample configuration
              </button>
              <button type="button" role="menuitem" (click)="resetDemo()">Reset demo…</button>
            </div>
          </details>
        </header>

        @if (store.notice(); as note) {
          <p class="ed-banner" [class.ed-banner-error]="note.kind === 'error'" role="status">
            {{ note.text }}
            <button type="button" class="ed-link" (click)="store.notice.set(null)">Dismiss</button>
          </p>
        }

        @if (mode() === 'configure') {
          <div class="ed-main">
            <aside class="ed-left" aria-label="Structure"><app-structure-panel /></aside>

            <section class="ed-center" aria-label="Canvas">
              <div class="ed-toolbar" role="toolbar" aria-label="Canvas tools">
                <div class="ed-tabs" role="group" aria-label="Canvas view">
                  <button
                    type="button"
                    class="ed-tab"
                    [attr.aria-pressed]="store.view() === 'mockup'"
                    (click)="store.view.set('mockup')"
                  >
                    Mockup view
                  </button>
                  <button
                    type="button"
                    class="ed-tab"
                    [attr.aria-pressed]="store.view() === 'artwork'"
                    (click)="store.view.set('artwork')"
                  >
                    Artwork view
                  </button>
                </div>

                @if (store.view() === 'mockup') {
                  <label class="ed-inline">
                    <span class="ed-label">Mockup</span>
                    <select
                      class="ed-input"
                      (change)="store.select({ kind: 'mockup', id: $any($event.target).value })"
                    >
                      @for (m of c.mockups; track m.id) {
                        <option [value]="m.id" [selected]="m.id === store.mockup()?.id">
                          {{ m.name }}
                        </option>
                      }
                    </select>
                  </label>
                  <button
                    type="button"
                    class="ed-btn"
                    [attr.aria-pressed]="store.tool().kind === 'select'"
                    (click)="store.tool.set({ kind: 'select' })"
                  >
                    Select
                  </button>
                  <button
                    type="button"
                    class="ed-btn"
                    [attr.aria-pressed]="isDrawing('rect')"
                    (click)="store.tool.set({ kind: 'draw', shape: 'rect' })"
                  >
                    Draw rectangle
                  </button>
                  <button
                    type="button"
                    class="ed-btn"
                    [attr.aria-pressed]="isDrawing('ellipse')"
                    (click)="store.tool.set({ kind: 'draw', shape: 'ellipse' })"
                  >
                    Draw ellipse
                  </button>
                } @else {
                  <label class="ed-inline">
                    <span class="ed-label">Area</span>
                    <select
                      class="ed-input"
                      (change)="store.select({ kind: 'area', id: $any($event.target).value })"
                    >
                      @for (a of c.printableAreas; track a.id) {
                        <option [value]="a.id" [selected]="a.id === store.area()?.id">
                          {{ a.name }}
                        </option>
                      }
                    </select>
                  </label>
                  <label class="ed-inline">
                    <span class="ed-label">Artwork</span>
                    <select
                      class="ed-input"
                      (change)="store.select({ kind: 'artwork', id: $any($event.target).value })"
                    >
                      @for (a of areaArtworks(); track a.id) {
                        <option [value]="a.id" [selected]="a.id === store.artwork()?.id">
                          {{ a.name }}
                        </option>
                      }
                    </select>
                  </label>
                }

                <span class="ed-grow"></span>
                <app-check
                  label="Boundaries"
                  [value]="store.showBoundaries()"
                  (changed)="store.showBoundaries.set($event)"
                />
                <app-check
                  label="Sample content"
                  [value]="store.sampleContent()"
                  (changed)="store.sampleContent.set($event)"
                />
                <div class="ed-row" role="group" aria-label="Zoom">
                  <button
                    type="button"
                    class="ed-btn"
                    aria-label="Zoom out"
                    (click)="stage()?.zoomBy(1 / 1.25)"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    class="ed-btn"
                    aria-label="Zoom in"
                    (click)="stage()?.zoomBy(1.25)"
                  >
                    +
                  </button>
                  <button type="button" class="ed-btn" (click)="stage()?.fit()">Fit</button>
                  <button type="button" class="ed-btn" (click)="stage()?.zoomActual()">100%</button>
                </div>
              </div>

              <div class="ed-stage-wrap"><app-stage /></div>

              <div class="ed-statusbar" role="status">
                <span>{{ statusText() }}</span>
                @if (store.issues().length > 0) {
                  <button
                    type="button"
                    class="ed-link ed-danger"
                    (click)="store.select({ kind: 'product' })"
                  >
                    {{ store.issues().length }} configuration problem(s)
                  </button>
                }
              </div>
            </section>

            <aside class="ed-right" aria-label="Properties"><app-properties-panel /></aside>
          </div>
        } @else {
          <div class="ed-preview">
            @if (previewConfig(); as pc) {
              <app-storefront-host [config]="pc" [storageId]="c.id" />
            }
          </div>
        }
      </div>
    } @else if (missing()) {
      <p class="page" role="alert">
        That product was not found. <a routerLink="/">Back to the product list</a>.
      </p>
    } @else {
      <p class="page" role="status">Loading editor…</p>
    }
  `,
})
export class EditorPageComponent {
  readonly id = input.required<string>();
  protected readonly store = inject(EditorStore);
  private readonly repo = inject(ConfigRepository);
  private readonly router = inject(Router);
  protected readonly stage = viewChild(StageComponent);

  protected readonly mode = signal<Mode>('configure');
  protected readonly previewConfig = signal<ProductConfig | null>(null);
  protected readonly missing = signal(false);

  protected readonly areaArtworks = computed(() => {
    const c = this.store.config();
    const area = this.store.area();
    return c && area ? c.artworks.filter((a) => a.printableAreaId === area.id) : [];
  });

  protected readonly statusText = computed(() => {
    const s = this.store.selection();
    const c = this.store.config();
    if (!c) return '';
    switch (s.kind) {
      case 'area':
        return `Area: ${c.printableAreas.find((a) => a.id === s.id)?.name ?? ''}`;
      case 'layer':
        return `Layer: ${this.store.layer()?.name ?? s.id}`;
      case 'mockup':
        return `Mockup: ${c.mockups.find((m) => m.id === s.id)?.name ?? ''}`;
      default:
        return this.store.view() === 'mockup'
          ? 'Mockup view: click a printable area to select it, drag to move, use the handles to resize or rotate.'
          : 'Artwork view: the production canvas. Boundaries and handles are editing aids and are never exported.';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.store.dispose());
    effect(() => {
      const id = this.id();
      this.mode.set('configure');
      void this.store.open(id).then((ok) => this.missing.set(!ok));
    });
    effect(() => {
      const note = this.store.notice();
      if (!note) return;
      const timer = setTimeout(() => this.store.notice.set(null), 7000);
      return () => clearTimeout(timer);
    });
  }

  protected isDrawing(shape: string): boolean {
    const tool = this.store.tool();
    return tool.kind === 'draw' && tool.shape === shape;
  }

  protected openPreview(): void {
    if (this.store.issues().length > 0) {
      this.store.notify(
        'error',
        `Fix ${this.store.issues().length} configuration problem(s) first: the storefront cannot load an invalid configuration.`,
      );
      return;
    }
    this.previewConfig.set(this.store.config());
    this.mode.set('preview');
  }

  protected leave(event: Event): void {
    if (this.store.dirty() && !confirm('Leave without saving your changes?'))
      event.preventDefault();
  }

  protected async resetDemo(): Promise<void> {
    if (
      !confirm(
        'Reset the demo? All edits and uploads in this browser are removed and the sample products are restored.',
      )
    )
      return;
    await this.repo.resetDemo();
    await this.router.navigateByUrl('/');
  }

  protected onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.store.save();
    } else if (mod && !typing && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.store.redo();
      else this.store.undo();
    } else if (mod && !typing && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.store.redo();
    }
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.store.dirty()) event.preventDefault();
  }
}
