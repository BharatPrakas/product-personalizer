import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** Application shell: navigation between the product list, the merchant editor and the demos. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="ed-skip" href="#main">Skip to content</a>
    <header class="app-header">
      <!-- <a class="app-brand" routerLink="/">Product Personalizer <span class="ed-badge">POC</span></a> -->
      <a class="app-brand" routerLink="/">Product Personalizer</a>
      <nav aria-label="Primary">
        <a routerLink="/" routerLinkActive="is-active" [routerLinkActiveOptions]="{ exact: true }"
          >Products</a
        >
        <a routerLink="/element-demo" routerLinkActive="is-active">Custom element demo</a>
      </nav>
    </header>
    <main id="main" class="app-main">
      <router-outlet />
    </main>
  `,
})
export class App {}
