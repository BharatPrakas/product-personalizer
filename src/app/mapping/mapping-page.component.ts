import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminHost } from '../admin/admin-host.service';
import { I18n, PluralPipe, TranslatePipe } from '../admin/i18n/i18n.service';
import type { MessageKey } from '../admin/i18n/messages.en';
import type { ProductRef } from '../customizer/models/admin-element-contract';
import { ConfirmService } from '../ui/confirm.service';
import { DialogComponent } from '../ui/dialog.component';
import { EmptyStateComponent } from '../ui/empty-state.component';
import { IconComponent } from '../ui/icon.component';
import { ToastService } from '../ui/toast.service';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import type { ConfigurationRecord } from '../workspace/configuration.models';
import {
  BulkMappingResult,
  MappingConflictError,
  MappingInvalidError,
  MappingScope,
  MappingTarget,
  ProductMapping,
} from './mapping.models';
import { indexMappings, statusFor, TargetStatus } from './mapping-resolution';
import { collectionsOf, ProductCatalog } from './product-catalog.service';
import { ProductMappingRepository } from './product-mapping-repository';

type Filter = 'all' | 'unmapped' | 'mapped' | 'conflict';

interface Row {
  key: string;
  externalId: string;
  name: string;
  sku?: string;
  imageUrl?: string;
  status: TargetStatus;
}

interface PendingConflict {
  targets: MappingTarget[];
  conflicts: { name: string; owner: string }[];
}

const PAGE = 100;

/**
 * Maps published templates to the host's products, variants or collections. One template is
 * active per target: a target owned by another template is shown as a conflict and only moves
 * after the merchant confirms a reassignment.
 */
@Component({
  selector: 'app-mapping-page',
  imports: [
    RouterLink,
    IconComponent,
    EmptyStateComponent,
    DialogComponent,
    TranslatePipe,
    PluralPipe,
  ],
  template: `
    <section class="page" aria-labelledby="mapping-title">
      <header class="page-header">
        <div>
          <h1 id="mapping-title">{{ 'mapping.title' | t }}</h1>
          <p>{{ 'mapping.lead' | t }}</p>
        </div>
        @if (state() === 'ready' && templates().length > 0) {
          <div class="context-picker">
            <label class="label" for="mapping-template">{{ 'mapping.template' | t }}</label>
            <select
              id="mapping-template"
              class="input"
              (change)="selectTemplate($any($event.target).value)"
            >
              @for (t of templates(); track t.id) {
                <option [value]="t.id" [selected]="t.id === selectedId()">
                  {{ t.draft.product.name }}
                </option>
              }
            </select>
          </div>
        }
      </header>

      @switch (state()) {
        @case ('loading') {
          <p class="loading-state" role="status">
            <span class="spinner" aria-hidden="true"></span> {{ 'common.loading' | t }}
          </p>
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
          @if (templates().length === 0) {
            <app-empty-state
              icon="layers"
              [title]="'mapping.template' | t"
              [description]="'mapping.template.none' | t"
            >
              <a class="btn btn--primary" routerLink="/configurations">{{ 'nav.templates' | t }}</a>
            </app-empty-state>
          } @else {
            <div class="index-card">
              <div class="index-tabs" role="group" aria-labelledby="mapping-filter-label">
                <span class="sr-only" id="mapping-filter-label">{{ 'mapping.filter.label' | t }}</span>
                @for (f of filters; track f.id) {
                  <button
                    type="button"
                    class="index-tab"
                    [attr.aria-pressed]="filter() === f.id"
                    (click)="filter.set(f.id)"
                  >
                    {{ f.label | t }}
                    <span class="index-tab__count">{{ counts()[f.id] }}</span>
                  </button>
                }
              </div>

              <div class="index-toolbar">
                <div class="index-select">
                  <label class="sr-only" for="mapping-filter">{{ 'mapping.filter.label' | t }}</label>
                  <select
                    id="mapping-filter"
                    class="input"
                    (change)="filter.set($any($event.target).value)"
                  >
                    @for (f of filters; track f.id) {
                      <option [value]="f.id" [selected]="filter() === f.id">
                        {{ f.label | t }} ({{ counts()[f.id] }})
                      </option>
                    }
                  </select>
                </div>
                <label class="search index-search">
                  <app-icon name="search" [size]="18" />
                  <span class="sr-only">{{ 'mapping.search' | t }}</span>
                  <input
                    class="input"
                    type="search"
                    [placeholder]="'mapping.search' | t"
                    [value]="query()"
                    (input)="query.set($any($event.target).value)"
                  />
                </label>
              </div>

              @if (catalogState() === 'loading') {
                <p class="loading-state" role="status">
                  <span class="spinner" aria-hidden="true"></span> {{ 'mapping.loading' | t }}
                </p>
              } @else if (catalogState() === 'error') {
                <div class="notice notice--danger" role="alert">
                  <app-icon name="alert" />
                  <span class="grow">{{ 'mapping.error.load' | t }}</span>
                  <button type="button" class="btn btn--sm" (click)="loadProducts()">
                    {{ 'common.retry' | t }}
                  </button>
                </div>
              } @else if (catalog.source() === 'none') {
                <p class="notice notice--warning" role="status">
                  <app-icon name="alert" /> <span>{{ 'mapping.empty.catalog' | t }}</span>
                </p>
              } @else if (rows().length === 0) {
                <app-empty-state icon="search" [title]="'mapping.empty.results' | t" description="" />
              } @else {
                <div
                  class="bulk-bar"
                  [class.has-selection]="selection().size > 0"
                  role="group"
                  [attr.aria-label]="'mapping.selected' | t: { count: selection().size }"
                >
                  <label class="check">
                    <input
                      type="checkbox"
                      [checked]="allVisibleSelected()"
                      [indeterminate]="someVisibleSelected()"
                      (change)="toggleAll($any($event.target).checked)"
                    />
                    <span>{{ 'common.select-all' | t }}</span>
                  </label>
                  <span class="bulk-bar__count" aria-live="polite">{{
                    'mapping.selected' | t: { count: selection().size }
                  }}</span>
                  <div class="bulk-bar__actions">
                    <button
                      type="button"
                      class="btn btn--primary btn--sm"
                      [disabled]="busy() || readonly() || mappableSelection().length === 0"
                      (click)="mapSelected()"
                    >
                      <app-icon name="check" [size]="16" /> {{ 'mapping.action.map' | t }}
                    </button>
                    <button
                      type="button"
                      class="btn btn--sm"
                      [disabled]="busy() || readonly() || unmappableSelection().length === 0"
                      (click)="unmapSelected()"
                    >
                      <app-icon name="close" [size]="16" /> {{ 'mapping.action.unmap' | t }}
                    </button>
                  </div>
                </div>

                <div class="table-wrap">
                  <table class="data-table mapping-table">
                    <caption class="sr-only">
                      {{
                        'mapping.table.caption' | t
                      }}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col" class="col-select">
                          <span class="sr-only">{{ 'mapping.col.select' | t }}</span>
                        </th>
                        <th scope="col">{{ 'mapping.col.name' | t }}</th>
                        <th scope="col">{{ 'mapping.col.sku' | t }}</th>
                        <th scope="col">{{ 'mapping.col.status' | t }}</th>
                        <th scope="col" class="actions">
                          <span class="sr-only">{{ 'mapping.action.map' | t }}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of visibleRows(); track row.key) {
                        <tr [class.is-selected]="selection().has(row.externalId)">
                          <td class="col-select">
                            <input
                              type="checkbox"
                              [checked]="selection().has(row.externalId)"
                              [attr.aria-label]="row.name"
                              (change)="toggle(row.externalId, $any($event.target).checked)"
                            />
                          </td>
                          <td>
                            <div class="cell-main">
                              @if (row.imageUrl) {
                                <img
                                  class="mapping-thumb"
                                  [src]="row.imageUrl"
                                  alt=""
                                  width="40"
                                  height="40"
                                  loading="lazy"
                                  referrerpolicy="no-referrer"
                                />
                              } @else {
                                <span class="mapping-thumb mapping-thumb--empty" aria-hidden="true">
                                  <app-icon name="image" [size]="18" />
                                </span>
                              }
                              <span class="row-title">{{ row.name }}</span>
                            </div>
                          </td>
                          <td class="sku" [attr.data-label]="'mapping.col.sku' | t">
                            @if (row.sku) {
                              {{ row.sku }}
                            }
                          </td>
                          <td [attr.data-label]="'mapping.col.status' | t">
                            @switch (row.status.kind) {
                              @case ('mapped') {
                                <span class="badge badge--success">
                                  <app-icon name="circle-check" [size]="14" />
                                  {{ 'mapping.status.mapped' | t }}
                                </span>
                              }
                              @case ('conflict') {
                                <span class="assignment">
                                  <span class="badge badge--warning">
                                    <app-icon name="alert" [size]="14" />
                                    {{ 'mapping.status.conflict' | t }}
                                  </span>
                                  <span class="assignment__detail">{{
                                    'mapping.status.conflict-detail'
                                      | t: { template: ownerName(row.status) }
                                  }}</span>
                                </span>
                              }
                              @default {
                                <span class="badge">
                                  <app-icon name="circle-empty" [size]="14" />
                                  {{ 'mapping.status.unmapped' | t }}
                                </span>
                              }
                            }
                          </td>
                          <td class="actions">
                            @if (row.status.kind === 'mapped') {
                              <button
                                type="button"
                                class="btn btn--sm"
                                [disabled]="busy() || readonly()"
                                (click)="unmapOne(row)"
                              >
                                {{ 'common.unmap' | t }}
                                <span class="sr-only">{{ row.name }}</span>
                              </button>
                            } @else {
                              <button
                                type="button"
                                class="btn btn--sm"
                                [disabled]="busy() || readonly()"
                                (click)="mapOne(row)"
                              >
                                {{
                                  row.status.kind === 'conflict'
                                    ? ('mapping.conflict.confirm' | t)
                                    : ('mapping.action.map' | t)
                                }}
                                <span class="sr-only">{{ row.name }}</span>
                              </button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (rows().length > visibleRows().length) {
                  <div class="index-footer">
                    <button type="button" class="btn" (click)="limit.update((n) => n + PAGE)">
                      {{ 'mapping.show-more' | t: { count: rows().length - visibleRows().length } }}
                    </button>
                  </div>
                }
                <p class="sr-only" role="status">
                  {{ 'mapping.results' | t: { count: rows().length } }}
                </p>
              }
            </div>
          }
        }
      }
    </section>

    <app-dialog
      [open]="pending() !== null"
      [title]="'mapping.conflict.title' | tn: (pending()?.conflicts?.length ?? 0)"
      [width]="520"
      (closed)="pending.set(null)"
    >
      <p>{{ 'mapping.conflict.message' | t: { template: selectedName() } }}</p>
      <ul class="plain-list conflict-list">
        @for (c of pending()?.conflicts?.slice(0, 8) ?? []; track $index) {
          <li>{{ 'mapping.conflict.item' | t: { name: c.name, template: c.owner } }}</li>
        }
      </ul>
      <ng-container dialogActions>
        <button type="button" class="btn" (click)="pending.set(null)">
          {{ 'common.cancel' | t }}
        </button>
        <button type="button" class="btn btn--primary" (click)="confirmReassign()">
          {{ 'mapping.conflict.confirm' | t }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class MappingPageComponent {
  /** Route parameter `/mapping/:configId` (component input binding). */
  readonly configId = input<string | undefined>();

  private readonly configs = inject(ConfigurationRepository);
  private readonly mappings = inject(ProductMappingRepository);
  protected readonly catalog = inject(ProductCatalog);
  private readonly host = inject(AdminHost);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(I18n);
  private readonly confirm = inject(ConfirmService);

  protected readonly PAGE = PAGE;
  protected readonly filters: { id: Filter; label: MessageKey }[] = [
    { id: 'all', label: 'mapping.filter.all' },
    { id: 'unmapped', label: 'mapping.filter.unmapped' },
    { id: 'mapped', label: 'mapping.filter.mapped' },
    { id: 'conflict', label: 'mapping.filter.conflict' },
  ];
  protected readonly readonly = this.host.readonly;

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly loadError = signal('');
  protected readonly catalogState = signal<'loading' | 'ready' | 'error'>('ready');
  private readonly records = signal<readonly ConfigurationRecord[]>([]);
  protected readonly allMappings = signal<readonly ProductMapping[]>([]);
  private readonly products = signal<readonly ProductRef[]>([]);

  protected readonly selectedId = signal<string | null>(null);
  /**
   * The page assigns templates to products only for now. Variant and collection mappings stay
   * supported by the repositories and the storefront resolution; only the switch is not offered.
   */
  protected readonly scope = signal<MappingScope>('product').asReadonly();
  protected readonly query = signal('');
  protected readonly filter = signal<Filter>('all');
  protected readonly selection = signal<ReadonlySet<string>>(new Set());
  protected readonly limit = signal(PAGE);
  protected readonly busy = signal(false);
  protected readonly pending = signal<PendingConflict | null>(null);

  /** Published, not archived: the only templates that can be served. */
  protected readonly templates = computed(() =>
    this.records().filter((r) => r.published !== null && r.archivedAt === null),
  );
  private readonly names = computed(
    () => new Map(this.records().map((r) => [r.id, r.draft.product.name])),
  );
  protected readonly selectedName = computed(() => this.names().get(this.selectedId() ?? '') ?? '');
  private readonly index = computed(() => indexMappings(this.allMappings()));

  private readonly baseRows = computed<Omit<Row, 'status'>[]>(() => {
    const products = this.products();
    switch (this.scope()) {
      case 'variant':
        return products.flatMap((p) =>
          (p.variants ?? []).map((v) => ({
            key: `variant:${v.id}`,
            externalId: v.id,
            name: `${p.title} — ${v.title}`,
            sku: v.sku ?? p.sku,
            imageUrl: p.imageUrl,
          })),
        );
      case 'collection':
        return collectionsOf(products).map((c) => ({
          key: `collection:${c.id}`,
          externalId: c.id,
          name: c.title,
        }));
      default:
        return products.map((p) => ({
          key: `product:${p.id}`,
          externalId: p.id,
          name: p.title,
          sku: p.sku,
          imageUrl: p.imageUrl,
        }));
    }
  });

  private readonly allRows = computed<Row[]>(() => {
    const configId = this.selectedId();
    if (!configId) return [];
    return this.baseRows().map((r) => ({
      ...r,
      status: statusFor(this.index(), this.scope(), r.externalId, configId),
    }));
  });

  protected readonly counts = computed<Record<Filter, number>>(() => {
    const rows = this.allRows();
    const count = (kind: TargetStatus['kind']) => rows.filter((r) => r.status.kind === kind).length;
    return {
      all: rows.length,
      unmapped: count('unmapped'),
      mapped: count('mapped'),
      conflict: count('conflict'),
    };
  });

  protected readonly rows = computed(() => {
    const f = this.filter();
    return f === 'all' ? this.allRows() : this.allRows().filter((r) => r.status.kind === f);
  });
  protected readonly visibleRows = computed(() => this.rows().slice(0, this.limit()));

  protected readonly allVisibleSelected = computed(
    () =>
      this.visibleRows().length > 0 &&
      this.visibleRows().every((r) => this.selection().has(r.externalId)),
  );
  protected readonly someVisibleSelected = computed(
    () =>
      !this.allVisibleSelected() &&
      this.visibleRows().some((r) => this.selection().has(r.externalId)),
  );

  private selectedRows(): Row[] {
    const sel = this.selection();
    return this.allRows().filter((r) => sel.has(r.externalId));
  }
  protected readonly mappableSelection = computed(() =>
    this.allRows().filter((r) => this.selection().has(r.externalId) && r.status.kind !== 'mapped'),
  );
  protected readonly unmappableSelection = computed(() =>
    this.allRows().filter((r) => this.selection().has(r.externalId) && r.status.kind === 'mapped'),
  );

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchAbort: AbortController | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchAbort?.abort();
    });

    void this.refresh();

    // Route parameter picks the template once the list is known.
    effect(() => {
      const wanted = this.configId();
      const list = this.templates();
      untracked(() => {
        if (wanted && list.some((t) => t.id === wanted)) this.selectedId.set(wanted);
        else if (!this.selectedId() || !list.some((t) => t.id === this.selectedId()))
          this.selectedId.set(list[0]?.id ?? null);
      });
    });

    // Search: instant for a host catalog, debounced for a remote search (endpoint or host SDK).
    effect(() => {
      this.query();
      this.catalog.source();
      this.host.productCatalog();
      this.host.productSearchUrl();
      untracked(() => this.scheduleSearch());
    });
  }

  // ---- loading ------------------------------------------------------------------------------

  protected async refresh(): Promise<void> {
    this.state.set('loading');
    try {
      const [records, mappings] = await Promise.all([
        this.configs.list({ includeArchived: true }),
        this.mappings.list(),
      ]);
      this.records.set(records);
      this.allMappings.set(mappings);
      this.state.set('ready');
    } catch {
      this.loadError.set(this.i18n.t('mapping.error.load'));
      this.state.set('error');
    }
  }

  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const delay = this.catalog.isRemote() ? 250 : 0;
    this.searchTimer = setTimeout(() => void this.loadProducts(), delay);
  }

  protected async loadProducts(): Promise<void> {
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    if (this.catalog.isRemote()) this.catalogState.set('loading');
    try {
      const found = await this.catalog.search(this.query(), controller.signal);
      if (controller.signal.aborted) return;
      this.products.set(found);
      this.limit.set(PAGE);
      this.catalogState.set('ready');
    } catch {
      if (controller.signal.aborted) return;
      this.products.set([]);
      this.catalogState.set('error');
    }
  }

  // ---- selection ----------------------------------------------------------------------------

  protected selectTemplate(id: string): void {
    this.selectedId.set(id);
    this.selection.set(new Set());
  }

  protected toggle(externalId: string, on: boolean): void {
    this.selection.update((s) => {
      const next = new Set(s);
      if (on) next.add(externalId);
      else next.delete(externalId);
      return next;
    });
  }

  protected toggleAll(on: boolean): void {
    this.selection.update((s) => {
      const next = new Set(s);
      for (const r of this.visibleRows()) {
        if (on) next.add(r.externalId);
        else next.delete(r.externalId);
      }
      return next;
    });
  }

  // ---- changes ------------------------------------------------------------------------------

  protected ownerName(status: TargetStatus): string {
    return status.kind === 'conflict'
      ? (this.names().get(status.mapping.configId) ?? status.mapping.configId)
      : '';
  }

  private target(row: Row): MappingTarget {
    return { scope: this.scope(), externalId: row.externalId, label: row.name.slice(0, 200) };
  }

  protected mapOne(row: Row): Promise<void> {
    return this.map([this.target(row)]);
  }

  protected mapSelected(): Promise<void> {
    return this.map(this.mappableSelection().map((r) => this.target(r)));
  }

  private async map(targets: MappingTarget[]): Promise<void> {
    const configId = this.selectedId();
    if (!configId || targets.length === 0) return;
    await this.run(async () => {
      const result = await this.mappings.bulk({ configId, create: targets });
      await this.afterBulk(result);
      if (result.conflicts.length > 0) {
        const byKey = new Map(targets.map((t) => [`${t.scope}:${t.externalId}`, t]));
        this.pending.set({
          targets: result.conflicts
            .map((c) => byKey.get(`${c.scope}:${c.externalId}`))
            .filter((t): t is MappingTarget => !!t),
          conflicts: result.conflicts.map((c) => ({
            name: byKey.get(`${c.scope}:${c.externalId}`)?.label || c.externalId,
            owner:
              this.names().get(c.existing.configId) ?? c.existing.configName ?? c.existing.configId,
          })),
        });
      }
    });
  }

  protected async confirmReassign(): Promise<void> {
    const pending = this.pending();
    const configId = this.selectedId();
    this.pending.set(null);
    if (!pending || !configId) return;
    await this.run(async () => {
      const result = await this.mappings.bulk({
        configId,
        create: pending.targets,
        reassign: true,
      });
      await this.afterBulk(result);
    });
  }

  protected unmapSelected(): Promise<void> {
    return this.removeIds(
      this.unmappableSelection().flatMap((r) =>
        r.status.kind === 'mapped' ? [r.status.mapping.id] : [],
      ),
    );
  }

  protected unmapOne(row: Row): Promise<void> {
    return this.removeIds(row.status.kind === 'mapped' ? [row.status.mapping.id] : []);
  }

  private async removeIds(ids: string[]): Promise<void> {
    const configId = this.selectedId();
    if (!configId || ids.length === 0) return;
    await this.run(async () => {
      const result = await this.mappings.bulk({ configId, deleteIds: ids });
      this.toasts.success(this.i18n.t('mapping.toast.unmapped', { count: result.deleted }));
      await this.reloadMappings();
    });
  }

  private async afterBulk(result: BulkMappingResult): Promise<void> {
    if (result.created.length)
      this.toasts.success(this.i18n.t('mapping.toast.mapped', { count: result.created.length }));
    if (result.reassigned.length)
      this.toasts.success(
        this.i18n.t('mapping.toast.reassigned', { count: result.reassigned.length }),
      );
    this.selection.set(new Set());
    await this.reloadMappings();
  }

  private async reloadMappings(): Promise<void> {
    this.allMappings.set(await this.mappings.list());
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
    } catch (error) {
      if (error instanceof MappingConflictError) {
        this.toasts.error(this.i18n.t('mapping.status.conflict'));
      } else if (error instanceof MappingInvalidError) {
        this.toasts.error(error.message);
      } else {
        this.toasts.error(this.i18n.t('mapping.error.save'));
      }
      await this.reloadMappings().catch(() => undefined);
    } finally {
      this.busy.set(false);
    }
  }
}
