import { Component, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ProductConfig } from '../../customizer/models/product.models';
import { StorefrontHostComponent } from '../components/storefront-host.component';
import { ConfigRepository } from '../services/config-repository.service';

/** Customer-facing view of a stored configuration (what a shopper would see). */
@Component({
  selector: 'app-storefront-page',
  imports: [StorefrontHostComponent, RouterLink],
  template: `
    <section class="page">
      <div class="page-head ed-row">
        <h1 class="ed-grow">Storefront preview</h1>
        <a class="ed-btn" [routerLink]="['/editor', id()]">Edit this product</a>
      </div>
      @if (config(); as c) {
        <app-storefront-host [config]="c" [storageId]="c.id" />
      } @else if (missing()) {
        <p role="alert">
          That product was not found. <a routerLink="/">Back to the product list</a>.
        </p>
      } @else {
        <p role="status">Loading…</p>
      }
    </section>
  `,
})
export class StorefrontPageComponent {
  readonly id = input.required<string>();
  private readonly repo = inject(ConfigRepository);
  private readonly router = inject(Router);
  protected readonly config = signal<ProductConfig | null>(null);
  protected readonly missing = signal(false);

  constructor() {
    effect(() => {
      const id = this.id();
      this.config.set(null);
      this.missing.set(false);
      void this.repo.get(id).then((stored) => {
        if (stored) this.config.set(stored.config);
        else this.missing.set(true);
      });
    });
    void this.router;
  }
}
