import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n, PluralPipe, TranslatePipe } from '../admin/i18n/i18n.service';
import { EmptyStateComponent } from '../ui/empty-state.component';
import { IconComponent } from '../ui/icon.component';
import { AuthImageComponent } from './auth-image.component';
import type { OrderSummary } from './order.models';
import { OrderRepository } from './order-repository';
import { dayBounds, mergePage, orderStatus, productNames } from './order-view';

const THUMBS = 4;

/**
 * Orders that carry personalized lines, newest first, with search and date filters and
 * cursor paging ("Load more"). Orders only exist on the connected backend: in the browser-only
 * workspace the page explains that instead of showing an empty table.
 */
@Component({
  selector: 'app-orders-page',
  imports: [RouterLink, IconComponent, EmptyStateComponent, AuthImageComponent, TranslatePipe, PluralPipe],
  template: `
    <section class="page" aria-labelledby="orders-title">
      <header class="page-header">
        <div>
          <h1 id="orders-title">{{ 'orders.title' | t }}</h1>
          <p>{{ 'orders.lead' | t }}</p>
        </div>
      </header>

      @if (!orders.available()) {
        <app-empty-state
          icon="file"
          [title]="'orders.local.title' | t"
          [description]="'orders.local.description' | t"
        />
      } @else {
        <div class="index-card">
          <form class="index-toolbar" role="search" (submit)="$event.preventDefault()">
            <label class="search index-search">
              <app-icon name="search" [size]="18" />
              <span class="sr-only">{{ 'orders.search' | t }}</span>
              <input
                id="orders-search"
                class="input"
                type="search"
                maxlength="200"
                [placeholder]="'orders.search' | t"
                [value]="query()"
                (input)="setQuery($any($event.target).value)"
              />
            </label>
            <div class="date-range">
              <label class="date-range__label" for="orders-from">{{ 'orders.filter.from' | t }}</label>
              <input
                id="orders-from"
                class="input"
                type="date"
                [value]="from()"
                [max]="to() || null"
                (change)="from.set($any($event.target).value); reload()"
              />
              <label class="date-range__label" for="orders-to">{{ 'orders.filter.to' | t }}</label>
              <input
                id="orders-to"
                class="input"
                type="date"
                [value]="to()"
                [min]="from() || null"
                (change)="to.set($any($event.target).value); reload()"
              />
            </div>
            @if (filtered()) {
              <button type="button" class="btn btn--ghost btn--sm" (click)="clearFilters()">
                <app-icon name="close" [size]="16" /> {{ 'orders.filter.clear' | t }}
              </button>
            }
          </form>

          @switch (state()) {
            @case ('loading') {
              <p class="loading-state" role="status">
                <span class="spinner" aria-hidden="true"></span> {{ 'orders.loading' | t }}
              </p>
            }
            @case ('error') {
              <div class="notice notice--danger" role="alert">
                <app-icon name="alert" />
                <span class="grow">{{ 'orders.error.load' | t }}</span>
                <button type="button" class="btn btn--sm" (click)="reload()">{{ 'common.retry' | t }}</button>
              </div>
            }
            @default {
              @if (items().length === 0) {
                <app-empty-state
                  [icon]="filtered() ? 'search' : 'file'"
                  [title]="(filtered() ? 'orders.empty.results' : 'orders.empty.title') | t"
                  [description]="(filtered() ? 'orders.empty.results-hint' : 'orders.empty.description') | t"
                >
                  @if (filtered()) {
                    <button type="button" class="btn" (click)="clearFilters()">{{ 'orders.filter.clear' | t }}</button>
                  }
                </app-empty-state>
              } @else {
                <div class="table-wrap">
                  <table class="data-table orders-table">
                    <caption class="sr-only">{{ 'orders.table.caption' | t }}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{{ 'orders.col.order' | t }}</th>
                        <th scope="col">{{ 'orders.col.placed' | t }}</th>
                        <th scope="col">{{ 'orders.col.items' | t }}</th>
                        <th scope="col">{{ 'orders.col.products' | t }}</th>
                        <th scope="col">{{ 'orders.col.status' | t }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (order of items(); track order.orderId) {
                        <tr>
                          <th scope="row">
                            <span class="cell-text">
                              <a class="row-title" [routerLink]="['/orders', order.orderId]">
                                {{ order.orderNumber ?? order.orderId }}
                              </a>
                              @if (order.customerName) {
                                <span class="cell-meta">{{ order.customerName }}</span>
                              }
                              @if (order.orderNumber) {
                                <span class="cell-meta mono">{{ order.orderId }}</span>
                              }
                            </span>
                          </th>
                          <td [attr.data-label]="'orders.col.placed' | t">
                            @if (order.placedAt) {
                              <span class="tabular">{{ date(order.placedAt) }}</span>
                            } @else {
                              <span class="cell-meta">{{ 'orders.linked-at' | t: { date: date(order.linkedAt) } }}</span>
                            }
                          </td>
                          <td [attr.data-label]="'orders.col.items' | t">
                            <span class="orders-items">
                              <span class="orders-thumbs">
                                @for (line of order.lines.slice(0, THUMBS); track line.lineId) {
                                  @if (line.previewAssetId) {
                                    <app-auth-image
                                      [customizationId]="line.customizationId"
                                      [assetId]="line.previewAssetId"
                                      [alt]="'orders.thumb.alt' | t: { name: line.title ?? line.productId }"
                                      [size]="40"
                                    />
                                  }
                                }
                              </span>
                              <span class="cell-meta">{{ 'orders.items' | tn: order.lineCount }}</span>
                            </span>
                          </td>
                          <td class="cell-wide" [attr.data-label]="'orders.col.products' | t">
                            <ul class="plain-list orders-products">
                              @for (name of names(order); track name) {
                                <li>{{ name }}</li>
                              }
                            </ul>
                          </td>
                          <td [attr.data-label]="'orders.col.status' | t">
                            @if (status(order) === 'expired') {
                              <span class="badge badge--warning badge--dot">{{ 'orders.status.expired' | t }}</span>
                            } @else {
                              <span class="badge badge--success badge--dot">{{ 'orders.status.ordered' | t }}</span>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (nextCursor() || moreError()) {
                  <div class="index-footer">
                    @if (moreError()) {
                      <div class="notice notice--danger" role="alert">
                        <app-icon name="alert" />
                        <span class="grow">{{ 'orders.error.load' | t }}</span>
                        <button type="button" class="btn btn--sm" (click)="loadMore()">{{ 'common.retry' | t }}</button>
                      </div>
                    } @else {
                      <button type="button" class="btn" [disabled]="loadingMore()" [attr.aria-busy]="loadingMore()" (click)="loadMore()">
                        @if (loadingMore()) {
                          <span class="spinner" aria-hidden="true"></span>
                        }
                        {{ (loadingMore() ? 'orders.loading-more' : 'orders.load-more') | t }}
                      </button>
                    }
                  </div>
                }
              }
              <p class="sr-only" role="status">{{ 'orders.results' | tn: items().length }}</p>
            }
          }
        </div>
      }
    </section>
  `,
})
export class OrdersPageComponent {
  protected readonly orders = inject(OrderRepository);
  private readonly i18n = inject(I18n);
  protected readonly THUMBS = THUMBS;

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly items = signal<readonly OrderSummary[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal(false);

  protected readonly query = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly filtered = computed(() => !!(this.query().trim() || this.from() || this.to()));

  private generation = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.generation++;
    });
    if (this.orders.available()) void this.reload();
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.reload(), 300);
  }

  protected clearFilters(): void {
    this.query.set('');
    this.from.set('');
    this.to.set('');
    void this.reload();
  }

  private filter() {
    return { q: this.query().trim() || undefined, ...dayBounds(this.from(), this.to()) };
  }

  protected async reload(): Promise<void> {
    const generation = ++this.generation;
    this.state.set('loading');
    this.moreError.set(false);
    try {
      const page = await this.orders.list(this.filter());
      if (generation !== this.generation) return;
      this.items.set(mergePage([], page.items, false));
      this.nextCursor.set(page.nextCursor);
      this.state.set('ready');
    } catch {
      if (generation === this.generation) this.state.set('error');
    }
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    const generation = this.generation;
    this.loadingMore.set(true);
    this.moreError.set(false);
    try {
      const page = await this.orders.list(this.filter(), cursor);
      if (generation !== this.generation) return;
      this.items.update((current) => mergePage(current, page.items, true));
      this.nextCursor.set(page.nextCursor);
    } catch {
      if (generation === this.generation) this.moreError.set(true);
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected date(iso: string): string {
    return this.i18n.date(new Date(iso));
  }

  protected names(order: OrderSummary): string[] {
    return productNames(order.lines);
  }

  protected status(order: OrderSummary): 'ordered' | 'expired' {
    return orderStatus(order);
  }
}
