import { NgOptimizedImage } from '@angular/common';
import { Component, DestroyRef, computed, inject, isDevMode, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ConfigIssue } from '../customizer/models/config.models';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import {
  ConfigurationTransferService,
  Thumbnail,
} from '../workspace/configuration-transfer.service';
import {
  ConfigurationRecord,
  ConfigurationSummary,
  summarize,
} from '../workspace/configuration.models';
import { ConfirmService } from '../ui/confirm.service';
import { EmptyStateComponent } from '../ui/empty-state.component';
import { IconComponent } from '../ui/icon.component';
import { MenuComponent } from '../ui/menu.component';
import { ToastService } from '../ui/toast.service';
import { DialogComponent } from '../ui/dialog.component';
import { NewConfigurationDialogComponent } from './new-configuration-dialog.component';
import { absoluteTime, relativeTime } from './relative-time';

type Filter = 'all' | 'draft' | 'published' | 'archived';

interface Row {
  summary: ConfigurationSummary;
  record: ConfigurationRecord;
}

/** The workspace landing page: every configuration, searchable and filterable, with lifecycle actions. */
@Component({
  selector: 'app-configurations-page',
  imports: [
    RouterLink,
    NgOptimizedImage,
    IconComponent,
    MenuComponent,
    EmptyStateComponent,
    DialogComponent,
    NewConfigurationDialogComponent,
  ],
  template: `
    <section class="page" aria-labelledby="page-title">
      <header class="page-header">
        <div>
          <h1 id="page-title">Configurations</h1>
          <p class="muted">Define how customers personalize each product.</p>
        </div>
        <div class="row">
          <label class="btn">
            <app-icon name="upload" />
            <span>Import</span>
            <input
              class="sr-only"
              type="file"
              accept="application/json,.json"
              (change)="onImport($event)"
            />
          </label>
          <button type="button" class="btn btn--primary" (click)="creating.set(true)">
            <app-icon name="plus" />
            <span>New configuration</span>
          </button>
        </div>
      </header>

      @if (storage().kind === 'memory') {
        <p class="notice notice--warning" role="status">
          <app-icon name="alert" /> <span>{{ storage().label }}</span>
        </p>
      }
      @if (importIssues().length > 0) {
        <div class="notice notice--danger" role="alert">
          <app-icon name="alert" />
          <div>
            <strong>That file could not be imported.</strong>
            <ul class="issue-list">
              @for (issue of importIssues().slice(0, 6); track $index) {
                <li>{{ issue.path ? issue.path + ': ' : '' }}{{ issue.message }}</li>
              }
            </ul>
          </div>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            aria-label="Dismiss"
            (click)="importIssues.set([])"
          >
            <app-icon name="close" [size]="16" />
          </button>
        </div>
      }

      @switch (state()) {
        @case ('loading') {
          <p class="muted" role="status">Loading configurations…</p>
        }
        @case ('error') {
          <div class="notice notice--danger" role="alert">
            <app-icon name="alert" />
            <span class="grow">{{ loadError() }}</span>
            <button type="button" class="btn btn--sm" (click)="refresh()">Try again</button>
          </div>
        }
        @default {
          @if (all().length === 0) {
            <app-empty-state
              icon="layers"
              title="No configurations yet"
              description="A configuration describes a product's mockups, printable areas and the artwork customers personalize. Create the first one to get started."
            >
              <button type="button" class="btn btn--primary" (click)="creating.set(true)">
                <app-icon name="plus" /> New configuration
              </button>
              @if (devMode) {
                <a class="btn" routerLink="/dev">Developer tools</a>
              }
            </app-empty-state>
          } @else {
            <div class="list-toolbar">
              <label class="search">
                <app-icon name="search" />
                <span class="sr-only">Search configurations</span>
                <input
                  class="input"
                  type="search"
                  placeholder="Search configurations"
                  [value]="query()"
                  (input)="query.set($any($event.target).value)"
                />
              </label>
              <div class="segmented" role="group" aria-label="Filter by status">
                @for (f of filters; track f.id) {
                  <button
                    type="button"
                    class="segmented-item"
                    [attr.aria-pressed]="filter() === f.id"
                    (click)="filter.set(f.id)"
                  >
                    {{ f.label }} <span class="segmented-count">{{ counts()[f.id] }}</span>
                  </button>
                }
              </div>
            </div>

            @if (rows().length === 0) {
              <app-empty-state
                icon="search"
                title="Nothing matches"
                description="Try a different search or filter."
              >
                <button type="button" class="btn" (click)="clearFilters()">Clear filters</button>
              </app-empty-state>
            } @else {
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Configuration</th>
                      <th scope="col">Status</th>
                      <th scope="col" class="num">Printable areas</th>
                      <th scope="col" class="num">Artworks</th>
                      <th scope="col">Last updated</th>
                      <th scope="col"><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of rows(); track row.summary.id) {
                      @let s = row.summary;
                      <tr [class.is-archived]="s.archived">
                        <td>
                          <div class="cell-main">
                            <div class="thumb">
                              @if (thumbs()[s.id]; as thumb) {
                                @if (thumb.local) {
                                  <img [src]="thumb.url" alt="" />
                                } @else {
                                  <img [ngSrc]="thumb.url" fill alt="" />
                                }
                              } @else {
                                <app-icon name="mockup" [size]="20" />
                              }
                            </div>
                            <div class="cell-text">
                              <a class="row-title" [routerLink]="['/configurations', s.id]">{{
                                s.name
                              }}</a>
                              <span class="subtle small">
                                {{ s.mockupCount }} {{ s.mockupCount === 1 ? 'mockup' : 'mockups' }}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          @if (s.archived) {
                            <span class="badge">Archived</span>
                          } @else if (s.status === 'published') {
                            <span class="badge badge--success"
                              >Published v{{ s.publishedVersion }}</span
                            >
                            @if (s.hasUnpublishedChanges) {
                              <span class="badge badge--warning">Unpublished changes</span>
                            }
                          } @else {
                            <span class="badge">Draft</span>
                          }
                        </td>
                        <td class="num" data-label="Printable areas">{{ s.areaCount }}</td>
                        <td class="num" data-label="Artworks">{{ s.artworkCount }}</td>
                        <td data-label="Updated">
                          <time [attr.datetime]="iso(s.updatedAt)" [title]="absolute(s.updatedAt)">
                            {{ relative(s.updatedAt) }}
                          </time>
                        </td>
                        <td class="actions">
                          <a class="btn btn--sm" [routerLink]="['/configurations', s.id]">Open</a>
                          <a
                            class="btn btn--sm btn--icon"
                            [routerLink]="['/preview', s.id]"
                            [queryParams]="s.status === 'draft' ? { draft: 1 } : null"
                            [attr.aria-label]="'Preview ' + s.name + ' as a customer'"
                            data-tip="Preview as customer"
                          >
                            <app-icon name="preview" [size]="16" />
                          </a>
                          <app-menu [label]="'More actions for ' + s.name" icon="more" align="end">
                            <button
                              type="button"
                              class="menu-item"
                              role="menuitem"
                              (click)="duplicate(s)"
                            >
                              <app-icon name="copy" [size]="16" /> Duplicate
                            </button>
                            @if (s.archived) {
                              <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                (click)="restore(s)"
                              >
                                <app-icon name="undo" [size]="16" /> Restore
                              </button>
                            } @else {
                              <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                (click)="archive(s)"
                              >
                                <app-icon name="archive" [size]="16" /> Archive
                              </button>
                            }
                            <div class="menu-sep"></div>
                            <button
                              type="button"
                              class="menu-item menu-item--danger"
                              role="menuitem"
                              (click)="remove(s)"
                            >
                              <app-icon name="trash" [size]="16" /> Delete…
                            </button>
                          </app-menu>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
          <p class="subtle small storage-note">{{ storage().label }}</p>
        }
      }
    </section>

    <app-new-configuration-dialog
      [open]="creating()"
      (closed)="creating.set(false)"
      (created)="onCreated($event)"
    />
    <app-dialog
      [open]="importing()"
      title="Importing"
      description="Checking the file before anything is stored."
      [width]="360"
      (closed)="importing.set(false)"
    >
      <p class="muted" role="status">Please wait…</p>
    </app-dialog>
  `,
})
export class ConfigurationsPageComponent {
  private readonly repo = inject(ConfigurationRepository);
  private readonly transfer = inject(ConfigurationTransferService);
  private readonly router = inject(Router);
  private readonly confirmService = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  protected readonly devMode = isDevMode();
  protected readonly storage = this.repo.storage;
  protected readonly filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Draft' },
    { id: 'published', label: 'Published' },
    { id: 'archived', label: 'Archived' },
  ];

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly loadError = signal('');
  protected readonly all = signal<readonly Row[]>([]);
  protected readonly query = signal('');
  protected readonly filter = signal<Filter>('all');
  protected readonly creating = signal(false);
  protected readonly importing = signal(false);
  protected readonly importIssues = signal<readonly ConfigIssue[]>([]);
  protected readonly thumbs = signal<Readonly<Record<string, Thumbnail>>>({});
  private readonly now = signal(Date.now());
  private revokers: (() => void)[] = [];

  protected readonly counts = computed<Record<Filter, number>>(() => {
    const rows = this.all();
    const live = rows.filter((r) => !r.summary.archived);
    return {
      all: live.length,
      draft: live.filter((r) => r.summary.status === 'draft').length,
      published: live.filter((r) => r.summary.status === 'published').length,
      archived: rows.filter((r) => r.summary.archived).length,
    };
  });

  protected readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    return this.all().filter(({ summary: s }) => {
      if (f === 'archived' ? !s.archived : s.archived) return false;
      if (f === 'draft' && s.status !== 'draft') return false;
      if (f === 'published' && s.status !== 'published') return false;
      return !q || s.name.toLowerCase().includes(q);
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.releaseThumbs());
    void this.refresh();
  }

  protected relative(ts: number): string {
    return relativeTime(ts, this.now());
  }
  protected absolute = absoluteTime;
  protected iso(ts: number): string {
    return new Date(ts).toISOString();
  }

  protected clearFilters(): void {
    this.query.set('');
    this.filter.set('all');
  }

  protected async refresh(): Promise<void> {
    this.state.set('loading');
    try {
      const records = await this.repo.list({ includeArchived: true });
      this.now.set(Date.now());
      this.all.set(records.map((record) => ({ record, summary: summarize(record) })));
      this.state.set('ready');
    } catch (error) {
      this.loadError.set(
        error instanceof Error ? error.message : 'The configurations could not be loaded.',
      );
      this.state.set('error');
      return;
    }
    this.releaseThumbs();
    const found: Record<string, Thumbnail> = {};
    for (const { record, summary } of this.all()) {
      const thumb = await this.transfer.thumbnail(record.draft);
      if (thumb) {
        found[summary.id] = thumb;
        this.revokers.push(thumb.revoke);
      }
    }
    this.thumbs.set(found);
  }

  private releaseThumbs(): void {
    this.revokers.forEach((revoke) => revoke());
    this.revokers = [];
  }

  protected onCreated(id: string): void {
    this.creating.set(false);
    void this.router.navigate(['/configurations', id]);
  }

  protected async onImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importIssues.set([]);
    this.importing.set(true);
    try {
      const result = await this.transfer.parseImport(await file.text());
      if (!result.ok) {
        this.importIssues.set(result.issues);
        return;
      }
      const record = await this.repo.createFromDraft(result.draft);
      this.toasts.success(`Imported “${record.draft.product.name}” as a draft.`);
      await this.refresh();
    } catch {
      this.toasts.error('The file could not be imported.');
    } finally {
      this.importing.set(false);
    }
  }

  protected async duplicate(s: ConfigurationSummary): Promise<void> {
    await this.run(async () => {
      const copy = await this.repo.duplicate(s.id);
      this.toasts.success(`Created “${copy.draft.product.name}”.`);
    });
  }

  protected async archive(s: ConfigurationSummary): Promise<void> {
    await this.run(async () => {
      await this.repo.archive(s.id);
      this.toasts.success(`Archived “${s.name}”. Find it under Archived.`);
    });
  }

  protected async restore(s: ConfigurationSummary): Promise<void> {
    await this.run(async () => {
      await this.repo.restore(s.id);
      this.toasts.success(`Restored “${s.name}”.`);
    });
  }

  protected async remove(s: ConfigurationSummary): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: 'Delete configuration?',
      message: `“${s.name}” and its uploaded images will be permanently deleted from this browser. This cannot be undone.`,
      confirmLabel: 'Delete configuration',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      await this.repo.delete(s.id);
      this.toasts.success(`Deleted “${s.name}”.`);
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      await this.refresh();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'That action failed.');
    }
  }
}
