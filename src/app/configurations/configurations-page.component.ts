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
import { AdminHost } from '../admin/admin-host.service';
import { I18n, PluralPipe, TranslatePipe } from '../admin/i18n/i18n.service';
import type { MessageKey } from '../admin/i18n/messages.en';
import { ProductMappingRepository } from '../mapping/product-mapping-repository';
import { DialogComponent } from '../ui/dialog.component';
import { NewConfigurationDialogComponent } from './new-configuration-dialog.component';
import { relativeTime } from './relative-time';

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
    TranslatePipe,
    PluralPipe,
  ],
  template: `
    <section class="page" aria-labelledby="page-title">
      <header class="page-header">
        <div>
          <h1 id="page-title">{{ 'list.title' | t }}</h1>
          <p class="muted">{{ 'list.lead' | t }}</p>
        </div>
        <div class="row">
          <label class="btn" [attr.aria-disabled]="readonly()">
            <app-icon name="upload" />
            <span>{{ 'list.import' | t }}</span>
            <input
              class="sr-only"
              type="file"
              [disabled]="readonly()"
              accept="application/json,.json"
              (change)="onImport($event)"
            />
          </label>
          <button
            type="button"
            class="btn btn--primary"
            [disabled]="readonly()"
            (click)="creating.set(true)"
          >
            <app-icon name="plus" />
            <span>{{ 'list.new' | t }}</span>
          </button>
        </div>
      </header>

      @if (storage().kind === 'memory') {
        <p class="notice notice--warning" role="status">
          <app-icon name="alert" /> <span>{{ storage().labelKey | t }}</span>
        </p>
      }
      @if (importIssues().length > 0) {
        <div class="notice notice--danger" role="alert">
          <app-icon name="alert" />
          <div>
            <strong>{{ 'list.import-failed' | t }}</strong>
            <ul class="issue-list">
              @for (issue of importIssues().slice(0, 6); track $index) {
                <li>{{ issue.path ? issue.path + ': ' : '' }}{{ issue.message }}</li>
              }
            </ul>
          </div>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            [attr.aria-label]="'common.dismiss' | t"
            (click)="importIssues.set([])"
          >
            <app-icon name="close" [size]="16" />
          </button>
        </div>
      }

      @switch (state()) {
        @case ('loading') {
          <p class="muted" role="status">{{ 'list.loading' | t }}</p>
        }
        @case ('error') {
          <div class="notice notice--danger" role="alert">
            <app-icon name="alert" />
            <span class="grow">{{ loadError() }}</span>
            <button type="button" class="btn btn--sm" (click)="refresh()">
              {{ 'common.retry' | t }}
            </button>
          </div>
        }
        @default {
          @if (all().length === 0) {
            <app-empty-state
              icon="layers"
              [title]="'list.empty.title' | t"
              [description]="'list.empty.description' | t"
            >
              <button type="button" class="btn btn--primary" (click)="creating.set(true)">
                <app-icon name="plus" /> {{ 'list.new' | t }}
              </button>
              @if (devMode) {
                <a class="btn" routerLink="/dev">{{ 'list.dev-tools' | t }}</a>
              }
            </app-empty-state>
          } @else {
            <div class="list-toolbar">
              <label class="search">
                <app-icon name="search" />
                <span class="sr-only">{{ 'list.search' | t }}</span>
                <input
                  class="input"
                  type="search"
                  [placeholder]="'list.search' | t"
                  [value]="query()"
                  (input)="query.set($any($event.target).value)"
                />
              </label>
              <div class="segmented" role="group" [attr.aria-label]="'list.filter-label' | t">
                @for (f of filters; track f.id) {
                  <button
                    type="button"
                    class="segmented-item"
                    [attr.aria-pressed]="filter() === f.id"
                    (click)="filter.set(f.id)"
                  >
                    {{ f.label | t }} <span class="segmented-count">{{ counts()[f.id] }}</span>
                  </button>
                }
              </div>
            </div>

            @if (rows().length === 0) {
              <app-empty-state
                icon="search"
                [title]="'list.nomatch.title' | t"
                [description]="'list.nomatch.description' | t"
              >
                <button type="button" class="btn" (click)="clearFilters()">
                  {{ 'list.clear-filters' | t }}
                </button>
              </app-empty-state>
            } @else {
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{{ 'list.col.configuration' | t }}</th>
                      <th scope="col">{{ 'list.col.status' | t }}</th>
                      <th scope="col" class="num">{{ 'list.col.areas' | t }}</th>
                      <th scope="col" class="num">{{ 'list.col.artworks' | t }}</th>
                      @if (embedded()) {
                        <th scope="col">{{ 'mapping.col.products' | t }}</th>
                      }
                      <th scope="col">{{ 'list.col.updated' | t }}</th>
                      <th scope="col">
                        <span class="sr-only">{{ 'list.col.actions' | t }}</span>
                      </th>
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
                                {{ 'list.mockups' | tn: s.mockupCount }}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          @if (s.archived) {
                            <span class="badge">{{ 'status.archived' | t }}</span>
                          } @else if (s.status === 'published') {
                            <span class="badge badge--success">{{
                              'list.published-version' | t: { version: s.publishedVersion ?? '' }
                            }}</span>
                            @if (s.hasUnpublishedChanges) {
                              <span class="badge badge--warning">{{
                                'list.unpublished-changes' | t
                              }}</span>
                            }
                          } @else {
                            <span class="badge">{{ 'status.draft' | t }}</span>
                          }
                        </td>
                        <td class="num" [attr.data-label]="'list.col.areas' | t">
                          {{ s.areaCount }}
                        </td>
                        <td class="num" [attr.data-label]="'list.col.artworks' | t">
                          {{ s.artworkCount }}
                        </td>
                        @if (embedded()) {
                          <td [attr.data-label]="'list.label.products' | t">
                            @let n = mappingCounts()[s.id] ?? 0;
                            @if (n > 0) {
                              <a [routerLink]="['/mapping', s.id]">{{
                                'mapping.current.count' | t: { count: n }
                              }}</a>
                            } @else {
                              <span class="subtle">{{ 'common.none' | t }}</span>
                            }
                          </td>
                        }
                        <td [attr.data-label]="'list.label.updated' | t">
                          <time [attr.datetime]="iso(s.updatedAt)" [title]="absolute(s.updatedAt)">
                            {{ relative(s.updatedAt) }}
                          </time>
                        </td>
                        <td class="actions">
                          <a class="btn btn--sm" [routerLink]="['/configurations', s.id]">{{
                            'list.open' | t
                          }}</a>
                          <a
                            class="btn btn--sm btn--icon"
                            [routerLink]="['/preview', s.id]"
                            [queryParams]="s.status === 'draft' ? { draft: 1 } : null"
                            [attr.aria-label]="'list.preview-aria' | t: { name: s.name }"
                            [attr.data-tip]="'list.preview-tip' | t"
                          >
                            <app-icon name="preview" [size]="16" />
                          </a>
                          <app-menu
                            [label]="'list.more-actions' | t: { name: s.name }"
                            icon="more"
                            align="end"
                            [disabled]="readonly()"
                          >
                            @if (embedded() && !s.archived && s.status === 'published') {
                              <a
                                class="menu-item"
                                role="menuitem"
                                [routerLink]="['/mapping', s.id]"
                              >
                                <app-icon name="list" [size]="16" /> {{ 'mapping.action.open' | t }}
                              </a>
                            }
                            <button
                              type="button"
                              class="menu-item"
                              role="menuitem"
                              (click)="duplicate(s)"
                            >
                              <app-icon name="copy" [size]="16" /> {{ 'common.duplicate' | t }}
                            </button>
                            @if (s.archived) {
                              <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                (click)="restore(s)"
                              >
                                <app-icon name="undo" [size]="16" /> {{ 'list.restore' | t }}
                              </button>
                            } @else {
                              <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                (click)="archive(s)"
                              >
                                <app-icon name="archive" [size]="16" /> {{ 'list.archive' | t }}
                              </button>
                            }
                            <div class="menu-sep"></div>
                            <button
                              type="button"
                              class="menu-item menu-item--danger"
                              role="menuitem"
                              (click)="remove(s)"
                            >
                              <app-icon name="trash" [size]="16" />
                              {{ 'common.delete-ellipsis' | t }}
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
          <p class="subtle small storage-note">{{ storage().labelKey | t }}</p>
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
      [title]="'list.importing.title' | t"
      [description]="'list.importing.description' | t"
      [width]="360"
      (closed)="importing.set(false)"
    >
      <p class="muted" role="status">{{ 'list.importing.wait' | t }}</p>
    </app-dialog>
  `,
})
export class ConfigurationsPageComponent {
  private readonly repo = inject(ConfigurationRepository);
  private readonly transfer = inject(ConfigurationTransferService);
  private readonly router = inject(Router);
  private readonly confirmService = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly host = inject(AdminHost);
  private readonly mappings = inject(ProductMappingRepository);
  private readonly i18n = inject(I18n);
  protected readonly readonly = this.host.readonly;
  protected readonly embedded = this.host.embedded;
  protected readonly mappingCounts = signal<Readonly<Record<string, number>>>({});

  protected readonly devMode = isDevMode();
  protected readonly storage = this.repo.storage;
  protected readonly filters: { id: Filter; label: MessageKey }[] = [
    { id: 'all', label: 'common.all' },
    { id: 'draft', label: 'status.draft' },
    { id: 'published', label: 'status.published' },
    { id: 'archived', label: 'status.archived' },
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
    return relativeTime(ts, this.now(), this.i18n);
  }
  protected absolute(ts: number): string {
    return this.i18n.date(ts);
  }
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
      void this.loadMappingCounts();
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : this.i18n.t('list.error.load'));
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

  /** How many products each template is mapped to (a failure just hides the counts). */
  private async loadMappingCounts(): Promise<void> {
    try {
      const counts: Record<string, number> = {};
      for (const m of await this.mappings.list())
        counts[m.configId] = (counts[m.configId] ?? 0) + 1;
      this.mappingCounts.set(counts);
    } catch {
      this.mappingCounts.set({});
    }
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
      this.toasts.success(this.i18n.t('list.toast.imported', { name: record.draft.product.name }));
      await this.refresh();
    } catch {
      this.toasts.error(this.i18n.t('list.toast.import-failed'));
    } finally {
      this.importing.set(false);
    }
  }

  protected async duplicate(s: ConfigurationSummary): Promise<void> {
    await this.run(async () => {
      const copy = await this.repo.duplicate(s.id);
      this.toasts.success(this.i18n.t('list.toast.created', { name: copy.draft.product.name }));
    });
  }

  protected async archive(s: ConfigurationSummary): Promise<void> {
    const mapped = this.mappingCounts()[s.id] ?? 0;
    if (mapped > 0) {
      const ok = await this.confirmService.confirm({
        title: this.i18n.t('archive.warn.title', { name: s.name }),
        message: this.i18n.t('archive.warn.mappings', { count: mapped }),
        confirmLabel: this.i18n.t('archive.warn.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    await this.run(async () => {
      await this.repo.archive(s.id);
      this.toasts.success(this.i18n.t('list.toast.archived', { name: s.name }));
    });
  }

  protected async restore(s: ConfigurationSummary): Promise<void> {
    await this.run(async () => {
      await this.repo.restore(s.id);
      this.toasts.success(this.i18n.t('list.toast.restored', { name: s.name }));
    });
  }

  protected async remove(s: ConfigurationSummary): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: this.i18n.t('list.delete.title'),
      message: this.i18n.t('list.delete.message', { name: s.name }),
      confirmLabel: this.i18n.t('list.delete.confirm'),
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      await this.repo.delete(s.id);
      await this.mappings.deleteForConfig(s.id);
      this.toasts.success(this.i18n.t('list.toast.deleted', { name: s.name }));
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      await this.refresh();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.i18n.t('list.error.action'));
    }
  }
}
