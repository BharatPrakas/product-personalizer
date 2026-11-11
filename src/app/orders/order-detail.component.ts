import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n, TranslatePipe } from '../admin/i18n/i18n.service';
import { downloadBlob } from '../editor/util/download';
import { EmptyStateComponent } from '../ui/empty-state.component';
import { IconComponent } from '../ui/icon.component';
import { ToastService } from '../ui/toast.service';
import { DownloadStatusComponent } from './download-status.component';
import { lineArchive, orderArchive, singleFileName, type LineSource } from './order-archive';
import { OrderDownloads } from './order-downloads';
import { LineSourceState, OrderLineCardComponent } from './order-line-card.component';
import { OrderAddress, OrderDetail, OrderFileMissingError, OrderLine, OrderNotFoundError } from './order.models';
import { OrderRepository } from './order-repository';
import { readSavedDesign, type FileView } from './order-view';

/** How many lines' designs are read at once (each is one small JSON request). */
const LINE_CONCURRENCY = 4;

/**
 * One order: its header (what the store sent; "Not provided by the store" otherwise), one card per
 * personalized line, and downloads — single files, one ZIP per line, one ZIP for the whole order.
 */
@Component({
  selector: 'app-order-detail',
  imports: [RouterLink, IconComponent, EmptyStateComponent, TranslatePipe, OrderLineCardComponent, DownloadStatusComponent],
  providers: [OrderDownloads],
  template: `
    <section class="page order-detail" aria-labelledby="order-title">
      <a class="btn btn--ghost btn--sm order-detail__back" routerLink="/orders">
        <app-icon name="arrow-left" [size]="16" /> {{ 'orders.back' | t }}
      </a>

      @switch (state()) {
        @case ('loading') {
          <h1 id="order-title" class="sr-only">{{ 'orders.title' | t }}</h1>
          <p class="muted" role="status">{{ 'orders.loading-order' | t }}</p>
        }
        @case ('not-found') {
          <h1 id="order-title" class="sr-only">{{ 'orders.title' | t }}</h1>
          <app-empty-state icon="search" [title]="'orders.not-found' | t" [description]="null">
            <a class="btn btn--primary" routerLink="/orders">{{ 'orders.back' | t }}</a>
          </app-empty-state>
        }
        @case ('error') {
          <h1 id="order-title" class="sr-only">{{ 'orders.title' | t }}</h1>
          <div class="notice notice--danger" role="alert">
            <app-icon name="alert" />
            <span class="grow">{{ 'orders.error.order' | t }}</span>
            <button type="button" class="btn btn--sm" (click)="load()">{{ 'common.retry' | t }}</button>
          </div>
        }
        @default {
          @if (order(); as o) {
            <header class="page-header">
              <div class="grow">
                <h1 id="order-title">{{ 'orders.detail.title' | t: { number: o.orderNumber ?? o.orderId } }}</h1>
                <p class="muted">
                  {{ o.placedAt ? ('orders.placed-at' | t: { date: date(o.placedAt) }) : ('orders.linked-at' | t: { date: date(o.linkedAt) }) }}
                </p>
              </div>
              <button
                type="button"
                class="btn btn--primary"
                [disabled]="downloads.busy() || !allReady()"
                (click)="downloadOrder()"
              >
                <app-icon name="download" [size]="16" /> {{ 'orders.download.order' | t }}
              </button>
            </header>

            <app-download-status />

            <div class="order-detail__summary">
              <section class="order-detail__box" aria-labelledby="order-info">
                <h2 id="order-info" class="order-detail__heading">{{ 'orders.detail.order' | t }}</h2>
                <dl class="facts">
                  <dt>{{ 'orders.detail.id' | t }}</dt>
                  <dd>{{ o.orderId }}</dd>
                  <dt>{{ 'orders.detail.number' | t }}</dt>
                  <dd>{{ o.orderNumber ?? ('orders.not-provided' | t) }}</dd>
                  <dt>{{ 'orders.detail.placed' | t }}</dt>
                  <dd>{{ o.placedAt ? date(o.placedAt) : ('orders.not-provided' | t) }}</dd>
                  <dt>{{ 'orders.detail.total' | t }}</dt>
                  <dd>{{ o.totals.total ? money(o.totals.total) : ('orders.not-provided' | t) }}</dd>
                  @for (row of totalRows(); track row.key) {
                    <dt>{{ row.label | t }}</dt>
                    <dd>{{ row.value }}</dd>
                  }
                </dl>
              </section>

              <section class="order-detail__box" aria-labelledby="order-customer">
                <h2 id="order-customer" class="order-detail__heading">{{ 'orders.detail.customer' | t }}</h2>
                @if (hasCustomer()) {
                  <dl class="facts">
                    <dt>{{ 'orders.customer.name' | t }}</dt>
                    <dd>{{ o.customer.name ?? ('orders.not-provided' | t) }}</dd>
                    <dt>{{ 'orders.customer.email' | t }}</dt>
                    <dd>{{ o.customer.email ?? ('orders.not-provided' | t) }}</dd>
                    <dt>{{ 'orders.customer.phone' | t }}</dt>
                    <dd>{{ o.customer.phone ?? ('orders.not-provided' | t) }}</dd>
                  </dl>
                } @else {
                  <p class="muted small">{{ 'orders.not-provided' | t }}</p>
                }
              </section>

              <section class="order-detail__box" aria-labelledby="order-shipping">
                <h2 id="order-shipping" class="order-detail__heading">{{ 'orders.detail.shipping' | t }}</h2>
                @if (o.shippingAddress; as a) {
                  <address class="order-detail__address">
                    @for (part of addressLines(a); track $index) { <span>{{ part }}</span> }
                  </address>
                } @else {
                  <p class="muted small">{{ 'orders.not-provided' | t }}</p>
                }
              </section>

              <section class="order-detail__box" aria-labelledby="order-billing">
                <h2 id="order-billing" class="order-detail__heading">{{ 'orders.detail.billing' | t }}</h2>
                @if (o.billingAddress; as a) {
                  <address class="order-detail__address">
                    @for (part of addressLines(a); track $index) { <span>{{ part }}</span> }
                  </address>
                } @else {
                  <p class="muted small">{{ 'orders.not-provided' | t }}</p>
                }
              </section>
            </div>

            <div class="order-detail__lines">
              @for (line of o.lines; track line.lineId) {
                <app-order-line-card
                  [order]="o"
                  [line]="line"
                  [state]="sourceOf(line)"
                  [busy]="downloads.busy()"
                  (downloadLine)="downloadLine(line)"
                  (downloadFile)="downloadFile(line, $event)"
                  (retry)="loadLine(line)"
                />
              }
            </div>
          }
        }
      }
    </section>
  `,
  styles: `
    .order-detail { display: grid; gap: var(--s-4); }
    .order-detail__back { justify-self: start; }
    .order-detail__summary { display: grid; gap: var(--s-3); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .order-detail__box {
      padding: var(--s-3); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-surface);
    }
    .order-detail__heading { font-size: var(--fs-lg); margin: 0 0 var(--s-2); }
    .order-detail__address { display: grid; font-style: normal; font-size: var(--fs-sm); }
    .order-detail__lines { display: grid; gap: var(--s-4); }
  `,
})
export class OrderDetailComponent {
  /** Route parameter `/orders/:orderId` (component input binding). */
  readonly orderId = input.required<string>();

  private readonly orders = inject(OrderRepository);
  protected readonly downloads = inject(OrderDownloads);
  private readonly i18n = inject(I18n);
  private readonly toasts = inject(ToastService);

  protected readonly state = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  protected readonly order = signal<OrderDetail | null>(null);
  private readonly sources = signal<ReadonlyMap<string, LineSourceState>>(new Map());
  protected readonly allReady = computed(() => {
    const o = this.order();
    return !!o && o.lines.every((l) => this.sources().get(l.lineId)?.status === 'ready');
  });
  protected readonly hasCustomer = computed(() => {
    const c = this.order()?.customer;
    return !!c && !!(c.name || c.email || c.phone);
  });
  protected readonly totalRows = computed(() => {
    const t = this.order()?.totals;
    if (!t) return [];
    return (['subtotal', 'shipping', 'tax', 'discount'] as const)
      .filter((key) => t[key] !== null)
      .map((key) => ({ key, label: `orders.totals.${key}` as const, value: this.money(t[key]!) }));
  });

  private generation = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.downloads.dismiss();
    });
    effect(() => {
      this.orderId();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    const generation = ++this.generation;
    this.state.set('loading');
    this.downloads.dismiss();
    try {
      const order = await this.orders.get(this.orderId());
      if (generation !== this.generation) return;
      this.order.set(order);
      this.sources.set(new Map(order.lines.map((l) => [l.lineId, { status: 'loading' } as const])));
      this.state.set('ready');
      void this.loadLines(order.lines, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.set(error instanceof OrderNotFoundError ? 'not-found' : 'error');
    }
  }

  private async loadLines(lines: readonly OrderLine[], generation: number): Promise<void> {
    const queue = [...lines];
    const worker = async () => {
      for (let line = queue.shift(); line; line = queue.shift()) {
        if (generation !== this.generation) return;
        await this.loadLine(line);
      }
    };
    await Promise.all(Array.from({ length: LINE_CONCURRENCY }, worker));
  }

  protected async loadLine(line: OrderLine): Promise<void> {
    const generation = this.generation;
    this.setSource(line.lineId, { status: 'loading' });
    try {
      const [customization, config] = await Promise.all([
        this.orders.customization(line.customization.id),
        this.orders.configVersion(line.customization.configId, line.customization.configVersion),
      ]);
      if (generation !== this.generation) return;
      const source: LineSource = {
        line,
        customization,
        design: customization.data ? readSavedDesign(customization.data) : null,
        config,
      };
      this.setSource(line.lineId, { status: 'ready', source });
    } catch {
      if (generation === this.generation) this.setSource(line.lineId, { status: 'error' });
    }
  }

  private setSource(lineId: string, state: LineSourceState): void {
    this.sources.update((m) => new Map(m).set(lineId, state));
  }

  protected sourceOf(line: OrderLine): LineSourceState {
    return this.sources().get(line.lineId) ?? { status: 'loading' };
  }

  private readySource(line: OrderLine): LineSource | null {
    const s = this.sources().get(line.lineId);
    return s?.status === 'ready' ? s.source : null;
  }

  // ---- downloads ------------------------------------------------------------------------------

  protected downloadLine(line: OrderLine): void {
    const order = this.order();
    const source = this.readySource(line);
    if (order && source) void this.downloads.start(lineArchive(order, source));
  }

  protected downloadOrder(): void {
    const order = this.order();
    if (!order) return;
    const sources = order.lines.map((l) => this.readySource(l)).filter((s): s is LineSource => !!s);
    if (sources.length === order.lines.length) void this.downloads.start(orderArchive(order, sources));
  }

  protected async downloadFile(line: OrderLine, file: FileView): Promise<void> {
    const order = this.order();
    if (!order || !file.asset) return;
    try {
      const blob = await this.orders.file(line.customization.id, file.asset.assetId);
      downloadBlob(blob, singleFileName(order, line, file));
    } catch (error) {
      this.toasts.error(this.i18n.t(error instanceof OrderFileMissingError ? 'orders.file.unavailable' : 'orders.file.error'));
    }
  }

  // ---- formatting -----------------------------------------------------------------------------

  protected date(iso: string): string {
    return this.i18n.date(new Date(iso));
  }

  protected money(amount: string): string {
    const currency = this.order()?.currency;
    if (!currency) return amount;
    try {
      return new Intl.NumberFormat(this.i18n.tag(), { style: 'currency', currency }).format(Number(amount));
    } catch {
      return `${amount} ${currency}`;
    }
  }

  protected addressLines(a: OrderAddress): string[] {
    const country = a.country ? this.countryName(a.country) : null;
    return [a.name, a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(' '), a.region, country, a.phone].filter(
      (v): v is string => !!v,
    );
  }

  private countryName(code: string): string {
    try {
      return new Intl.DisplayNames([this.i18n.tag()], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  }
}
