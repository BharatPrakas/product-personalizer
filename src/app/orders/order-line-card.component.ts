import { Component, computed, inject, input, output, signal } from '@angular/core';
import { I18n, TranslatePipe } from '../admin/i18n/i18n.service';
import type { MessageKey } from '../admin/i18n/messages.en';
import { DialogComponent } from '../ui/dialog.component';
import { IconComponent } from '../ui/icon.component';
import { AuthImageComponent } from './auth-image.component';
import type { LineSource } from './order-archive';
import type { OrderDetail, OrderLine } from './order.models';
import { customerInputs, lineFiles, priceOf, type FileView } from './order-view';

/** What the detail page knows about a line's saved design. */
export type LineSourceState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; source: LineSource };

/** One personalized order line: product, template, preview gallery, customer inputs and files. */
@Component({
  selector: 'app-order-line-card',
  imports: [AuthImageComponent, DialogComponent, IconComponent, TranslatePipe],
  template: `
    <article class="line-card" [attr.aria-labelledby]="headingId()">
      <header class="line-card__head">
        <div class="line-card__heading">
          <h2 class="line-card__title" [id]="headingId()">{{ line().title ?? line().productId }}</h2>
          <p class="line-card__sub">
            {{ 'orders.line.id' | t: { id: line().lineId } }}
            @if (line().quantity !== null && line().quantity !== undefined) {
              <span aria-hidden="true"> · </span>{{ 'orders.line.quantity-short' | t: { count: line().quantity! } }}
            }
          </p>
        </div>
        <button type="button" class="btn btn--sm" [disabled]="busy() || state().status !== 'ready'" (click)="downloadLine.emit()">
          <app-icon name="download" [size]="16" />
          {{ 'orders.download.line' | t }}
          <span class="sr-only">{{ line().title ?? line().lineId }}</span>
        </button>
      </header>

      <div class="line-card__overview">
        <div class="line-card__media">
          <h3 class="line-card__section">{{ 'orders.line.previews' | t }}</h3>
          @switch (state().status) {
            @case ('ready') {
              @if (previews().length === 0) {
                <p class="missing">{{ 'orders.line.none' | t }}</p>
              } @else {
                <ul class="plain-list line-card__gallery">
                  @for (file of previews(); track $index) {
                    <li>
                      <button
                        type="button"
                        class="line-card__thumb"
                        [disabled]="!file.asset"
                        [attr.aria-label]="'orders.preview.open' | t: { name: file.label }"
                        (click)="openPreview($index)"
                      >
                        <app-auth-image [customizationId]="line().customization.id" [assetId]="file.asset?.assetId ?? null" alt="" [size]="128" />
                      </button>
                      <span class="line-card__thumb-label">{{ file.label }}</span>
                    </li>
                  }
                </ul>
              }
            }
            @default {
              <div class="line-card__placeholder" aria-hidden="true"></div>
            }
          }
        </div>

        <dl class="facts line-card__facts">
          <dt>{{ 'orders.line.template' | t }}</dt>
          <dd>
            @if (config(); as c) {
              {{ 'orders.line.template-named' | t: { name: c.product.name, version: line().customization.configVersion } }}
              <span class="cell-meta mono block">{{ line().customization.configId }}</span>
            } @else {
              {{ 'orders.line.template-version' | t: { id: line().customization.configId, version: line().customization.configVersion } }}
            }
          </dd>
          <dt>{{ 'orders.line.design' | t }}</dt>
          <dd>
            @if (line().customization.status === 'expired') {
              <span class="badge badge--warning badge--dot">{{ 'orders.status.expired' | t }}</span>
            } @else {
              <span class="badge badge--success badge--dot">{{ 'orders.status.ordered' | t }}</span>
            }
          </dd>
          <dt>{{ 'orders.line.product' | t }}</dt>
          <dd class="mono">{{ line().productId }}</dd>
          <dt>{{ 'orders.line.variant' | t }}</dt>
          <dd>
            @if (line().variantId) { <span class="mono">{{ line().variantId }}</span> } @else { <span class="missing">{{ 'orders.not-supplied' | t }}</span> }
          </dd>
          <dt>{{ 'orders.line.sku' | t }}</dt>
          <dd>
            @if (line().sku) { <span class="mono">{{ line().sku }}</span> } @else { <span class="missing">{{ 'orders.not-supplied' | t }}</span> }
          </dd>
          <dt>{{ 'orders.line.quantity' | t }}</dt>
          <dd class="tabular">
            @if (line().quantity !== null && line().quantity !== undefined) { {{ line().quantity }} } @else { <span class="missing">{{ 'orders.not-supplied' | t }}</span> }
          </dd>
          <dt>{{ 'orders.line.unit-price' | t }}</dt>
          <dd class="tabular">
            @if (line().unitPrice) { {{ money(line().unitPrice!) }} } @else { <span class="missing">{{ 'orders.not-supplied' | t }}</span> }
          </dd>
        </dl>
      </div>

      @switch (state().status) {
        @case ('loading') {
          <p class="line-card__loading" role="status">
            <span class="spinner" aria-hidden="true"></span> {{ 'orders.line.loading' | t }}
          </p>
        }
        @case ('error') {
          <div class="notice notice--danger" role="alert">
            <app-icon name="alert" />
            <span class="grow">{{ 'orders.line.error' | t }}</span>
            <button type="button" class="btn btn--sm" (click)="retry.emit()">{{ 'common.retry' | t }}</button>
          </div>
        }
        @default {
          @if (!config()) {
            <p class="notice notice--warning" role="note">
              <app-icon name="info" /> <span>{{ 'orders.line.no-template' | t }}</span>
            </p>
          }

          <section class="line-card__block" [attr.aria-labelledby]="headingId() + '-inputs'">
            <h3 class="line-card__section" [id]="headingId() + '-inputs'">{{ 'orders.line.inputs' | t }}</h3>
            @if (inputs().length === 0) {
              <p class="missing">{{ 'orders.line.none' | t }}</p>
            } @else {
              <dl class="facts line-card__inputs">
                @for (item of inputs(); track item.kind + item.fieldId) {
                  <dt>{{ item.label }}</dt>
                  <dd>
                    @switch (item.kind) {
                      @case ('text') {
                        @if (item.text) {
                          <span class="line-card__text">{{ item.text }}</span>
                        } @else {
                          <span class="missing">{{ 'orders.input.empty' | t }}</span>
                        }
                        <span class="cell-meta block">
                          @if (item.font) { {{ 'orders.input.font' | t: { font: item.font } }} }
                          @if (item.color) {
                            <span class="line-card__swatch" [style.background]="item.color" aria-hidden="true"></span>
                            {{ 'orders.input.color' | t: { color: item.color } }}
                          }
                          @for (s of item.styles; track s) { · {{ styleLabel(s) | t }} }
                        </span>
                      }
                      @case ('image') {
                        @if (item.assetId) {
                          <app-auth-image [customizationId]="line().customization.id" [assetId]="item.assetId" [alt]="item.label" [size]="96" />
                        } @else {
                          <span class="missing">{{ 'orders.input.no-photo' | t }}</span>
                        }
                        <span class="cell-meta block">{{ cropText(item) }}</span>
                      }
                      @default {
                        @if (item.value) { {{ item.value }} } @else { <span class="missing">{{ 'orders.input.empty' | t }}</span> }
                      }
                    }
                  </dd>
                }
              </dl>
            }
          </section>

          @if (price(); as p) {
            <section class="line-card__block" [attr.aria-labelledby]="headingId() + '-price'">
              <h3 class="line-card__section" [id]="headingId() + '-price'">{{ 'orders.line.price' | t }}</h3>
              <dl class="facts">
                <dt>{{ 'orders.price.base' | t }}</dt>
                <dd class="tabular">{{ p.base }}</dd>
                <dt>{{ 'orders.price.fee' | t }}</dt>
                <dd class="tabular">{{ p.fee }}</dd>
                <dt>{{ 'orders.price.total' | t }}</dt>
                <dd class="tabular">{{ p.total }}</dd>
              </dl>
              <p class="cell-meta">{{ 'orders.price.note' | t }}</p>
            </section>
          }

          <section class="line-card__block" [attr.aria-labelledby]="headingId() + '-files'">
            <h3 class="line-card__section" [id]="headingId() + '-files'">{{ 'orders.line.files' | t }}</h3>
            <ul class="plain-list line-card__files">
              @for (file of files(); track $index) {
                <li class="line-card__file">
                  <span class="line-card__file-icon" aria-hidden="true">
                    <app-icon [name]="file.group === 'production' ? 'artwork' : file.group === 'previews' ? 'preview' : 'image'" [size]="18" />
                  </span>
                  <span class="line-card__file-text">
                    <span class="line-card__file-name">{{ file.label }}</span>
                    <span class="line-card__file-meta">
                      <span class="badge" [class.badge--info]="file.group === 'production'">{{ groupLabel(file) | t }}</span>
                      @if (file.width && file.height) {
                        <span>{{ 'preview.png-size' | t: { width: file.width, height: file.height } }}</span>
                      }
                    </span>
                  </span>
                  @if (file.asset) {
                    <button type="button" class="btn btn--sm" [disabled]="busy()" (click)="downloadFile.emit(file)">
                      <app-icon name="download" [size]="16" /> {{ 'orders.download.file' | t }}
                      <span class="sr-only">{{ file.label }}</span>
                    </button>
                  } @else {
                    <span class="badge badge--warning">{{ 'orders.file.unavailable' | t }}</span>
                  }
                </li>
              } @empty {
                <li class="missing">{{ 'orders.line.none' | t }}</li>
              }
            </ul>
          </section>
        }
      }
    </article>

    <app-dialog
      [open]="lightbox() !== null"
      [title]="lightboxFile()?.label ?? ''"
      [width]="640"
      (closed)="lightbox.set(null)"
    >
      @if (lightboxFile(); as file) {
        <div class="line-card__lightbox">
          <app-auth-image
            [customizationId]="line().customization.id"
            [assetId]="file.asset?.assetId ?? null"
            [alt]="'orders.preview.alt' | t: { name: file.label }"
            [size]="560"
          />
        </div>
        <p class="cell-meta" aria-live="polite">
          {{ 'orders.preview.position' | t: { index: lightbox()! + 1, total: previews().length } }}
        </p>
      }
      <ng-container dialogActions>
        <button type="button" class="btn" [disabled]="previews().length < 2" (click)="step(-1)">
          <app-icon name="chevron-left" [size]="16" /> {{ 'orders.preview.previous' | t }}
        </button>
        <button type="button" class="btn" [disabled]="previews().length < 2" (click)="step(1)">
          {{ 'orders.preview.next' | t }} <app-icon name="chevron-right" [size]="16" />
        </button>
        <button type="button" class="btn btn--primary" (click)="lightbox.set(null)">{{ 'common.close' | t }}</button>
      </ng-container>
    </app-dialog>
  `,
})
export class OrderLineCardComponent {
  readonly order = input.required<OrderDetail>();
  readonly line = input.required<OrderLine>();
  readonly state = input.required<LineSourceState>();
  readonly busy = input(false);
  readonly downloadLine = output<void>();
  readonly downloadFile = output<FileView>();
  readonly retry = output<void>();

  private readonly i18n = inject(I18n);
  protected readonly lightbox = signal<number | null>(null);

  protected readonly headingId = computed(() => `line-${this.line().lineId.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  private readonly source = computed(() => {
    const s = this.state();
    return s.status === 'ready' ? s.source : null;
  });
  protected readonly config = computed(() => this.source()?.config ?? null);
  protected readonly files = computed(() => lineFiles(this.line(), this.source()?.design ?? null, this.config()));
  protected readonly previews = computed(() => this.files().filter((f) => f.group === 'previews'));
  protected readonly lightboxFile = computed(() => {
    const index = this.lightbox();
    return index === null ? null : (this.previews()[index] ?? null);
  });
  protected readonly inputs = computed(() => {
    const design = this.source()?.design;
    return design ? customerInputs(design, this.config()) : [];
  });
  protected readonly price = computed(() => {
    const snapshot = this.source()?.design?.displayPrice;
    if (!snapshot) return null;
    const p = priceOf(snapshot);
    const format = (n: number) => this.formatMoney(n, snapshot.currency);
    return { base: format(p.base), fee: format(p.fee), total: format(p.total) };
  });

  protected openPreview(index: number): void {
    this.lightbox.set(index);
  }

  protected step(delta: number): void {
    const count = this.previews().length;
    this.lightbox.update((i) => (i === null || count === 0 ? i : (i + delta + count) % count));
  }

  protected money(amount: string): string {
    return this.formatMoney(Number(amount), this.order().currency);
  }

  private formatMoney(amount: number, currency: string | null): string {
    if (!currency) return String(amount);
    try {
      return new Intl.NumberFormat(this.i18n.tag(), { style: 'currency', currency }).format(amount);
    } catch {
      return `${amount} ${currency}`;
    }
  }

  protected styleLabel(style: string): MessageKey {
    return style === 'bold' ? 'orders.input.bold' : style === 'italic' ? 'orders.input.italic' : 'orders.input.underline';
  }

  protected groupLabel(file: FileView): MessageKey {
    return file.group === 'production'
      ? 'orders.files.production'
      : file.group === 'previews'
        ? 'orders.files.preview'
        : 'orders.files.upload';
  }

  protected cropText(item: { crop: readonly number[] | null; fit: string | null; rotation: number }): string {
    const parts: string[] = [];
    if (item.crop) {
      const [l, t, w, h] = item.crop.map((n) => Math.round(n * 1000) / 10);
      parts.push(this.i18n.t('orders.input.crop', { left: l, top: t, width: w, height: h }));
    }
    if (item.fit) parts.push(this.i18n.t(item.fit === 'contain' ? 'orders.input.fit-contain' : 'orders.input.fit-cover'));
    if (item.rotation) parts.push(this.i18n.t('orders.input.rotation', { degrees: item.rotation }));
    return parts.join(' · ');
  }
}
