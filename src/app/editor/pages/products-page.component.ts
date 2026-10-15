import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ConfigIssue } from '../../customizer/models/config.models';
import { ConfigRepository, StoredConfig } from '../services/config-repository.service';
import { CONTROLS } from '../components/controls.component';

/** Searchable list of the locally stored products, with create / import / reset-demo actions. */
@Component({
  selector: 'app-products-page',
  imports: [RouterLink, NgOptimizedImage, CONTROLS],
  template: `
    <section class="page" aria-labelledby="products-title">
      <div class="page-head">
        <h1 id="products-title">Products</h1>
        <p class="ed-hint">
          Local sample products. Open one in the merchant editor to configure mockups, printable
          areas and artwork, or in the storefront to try the generated customer inputs. Everything
          is saved in this browser only.
        </p>
      </div>

      <div class="ed-toolbar" role="group" aria-label="Product actions">
        <label class="ed-field ed-grow">
          <span class="ed-label">Search products</span>
          <input
            class="ed-input"
            type="search"
            placeholder="Name, variant or id"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </label>
        <button type="button" class="ed-btn ed-btn-primary" (click)="create()">
          New configuration
        </button>
        <app-file
          label="Import JSON"
          accept="application/json,.json"
          (chosen)="importFile($event)"
        />
        <button type="button" class="ed-btn" (click)="resetDemo()">Reset demo</button>
      </div>

      @if (repo.storageNote(); as note) {
        <p class="ed-banner ed-banner-warn" role="status">{{ note }}</p>
      }
      @if (message(); as text) {
        <p class="ed-banner" role="status">{{ text }}</p>
      }
      @if (importIssues().length > 0) {
        <div class="ed-banner ed-banner-error" role="alert">
          <strong>That file is not a valid configuration.</strong>
          <ul>
            @for (issue of importIssues().slice(0, 8); track $index) {
              <li>
                <code>{{ issue.path || 'config' }}</code> {{ issue.message }}
              </li>
            }
          </ul>
        </div>
      }

      @if (loading()) {
        <p role="status">Loading products…</p>
      } @else if (filtered().length === 0) {
        <p role="status">No products match “{{ query() }}”.</p>
      } @else {
        <ul class="product-grid">
          @for (item of filtered(); track item.id) {
            <li class="product-card">
              <div class="product-thumb">
                @if (thumbs()[item.id]; as thumb) {
                  @if (thumb.local) {
                    <!-- Browser-stored uploads are blob: URLs, which NgOptimizedImage cannot serve. -->
                    <img [src]="thumb.url" alt="" />
                  } @else {
                    <img [ngSrc]="thumb.url" fill alt="" />
                  }
                }
              </div>
              <div class="product-body">
                <h2 class="product-title">{{ item.config.product.name }}</h2>
                <p class="ed-hint">
                  {{ item.config.printableAreas.length }} printable areas ·
                  {{ item.config.mockups.length }} mockups ·
                  {{ item.config.fields.length }} customer fields
                </p>
                <p class="chip-line">
                  @for (v of item.config.variants; track v.id) {
                    <span class="ed-chip">{{ v.label }}</span>
                  }
                </p>
                <p class="ed-hint">
                  <span class="ed-badge">{{ item.config.status }}</span>
                  v{{ item.config.version }}{{ item.sample ? ' · sample' : '' }}
                </p>
                <div class="ed-row">
                  <a class="ed-btn ed-btn-primary" [routerLink]="['/editor', item.id]">Edit</a>
                  <a class="ed-btn" [routerLink]="['/storefront', item.id]">Storefront</a>
                  <button type="button" class="ed-btn ed-btn-danger" (click)="remove(item)">
                    Delete
                  </button>
                </div>
              </div>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ProductsPageComponent {
  protected readonly repo = inject(ConfigRepository);
  private readonly router = inject(Router);

  protected readonly items = signal<readonly StoredConfig[]>([]);
  protected readonly loading = signal(true);
  protected readonly query = signal('');
  protected readonly message = signal<string | null>(null);
  protected readonly importIssues = signal<readonly ConfigIssue[]>([]);
  protected readonly thumbs = signal<Readonly<Record<string, { url: string; local: boolean }>>>({});
  private revokers: (() => void)[] = [];

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.items();
    return this.items().filter((item) =>
      [item.config.product.name, item.id, ...item.config.variants.map((v) => v.label)]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.releaseThumbs());
    void this.refresh();
  }

  private releaseThumbs(): void {
    this.revokers.forEach((revoke) => revoke());
    this.revokers = [];
  }

  private async refresh(): Promise<void> {
    this.loading.set(true);
    const items = await this.repo.list();
    this.items.set(items);
    this.releaseThumbs();
    const urls: Record<string, { url: string; local: boolean }> = {};
    for (const item of items) {
      const thumb = await this.repo.thumbnail(item.config);
      if (thumb) {
        urls[item.id] = { url: thumb.url, local: thumb.url.startsWith('blob:') };
        this.revokers.push(thumb.revoke);
      }
    }
    this.thumbs.set(urls);
    this.loading.set(false);
  }

  protected async create(): Promise<void> {
    const record = await this.repo.create(`New product ${this.items().length + 1}`);
    await this.router.navigate(['/editor', record.id]);
  }

  protected async importFile(file: File): Promise<void> {
    this.importIssues.set([]);
    const result = await this.repo.importJson(await file.text());
    if (!result.ok) {
      this.importIssues.set(result.issues);
      return;
    }
    const record = await this.repo.save(result.config);
    this.message.set(`Imported “${record.config.product.name}”.`);
    await this.refresh();
  }

  protected async resetDemo(): Promise<void> {
    if (
      !confirm(
        'Reset the demo? Your edits and uploads in this browser are removed and the sample products are restored.',
      )
    )
      return;
    await this.repo.resetDemo();
    this.message.set('Demo reset: the sample products are back to their original state.');
    this.importIssues.set([]);
    await this.refresh();
  }

  protected async remove(item: StoredConfig): Promise<void> {
    if (!confirm(`Delete “${item.config.product.name}” from this browser?`)) return;
    await this.repo.remove(item.id);
    await this.refresh();
  }
}
