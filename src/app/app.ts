import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { ConfirmHostComponent } from './ui/confirm-host.component';
import { ToastHostComponent } from './ui/toast-host.component';

/** Application shell. The editor and the customer preview bring their own header and use the full window. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ConfirmHostComponent, ToastHostComponent],
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    @if (!immersive()) {
      <header class="app-header">
        <a
          class="brand"
          routerLink="/configurations"
          aria-label="Product Personalizer, configurations"
        >
          <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect width="24" height="24" rx="6" fill="currentColor" />
            <path
              d="M7 16.5V7.5h5a2.7 2.7 0 0 1 0 5.4H7"
              fill="none"
              stroke="#fff"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>Product Personalizer</span>
        </a>
        <nav aria-label="Primary">
          <a routerLink="/configurations" routerLinkActive="is-active">Configurations</a>
        </nav>
      </header>
    }
    <main id="main" class="app-main" [class.app-main--immersive]="immersive()">
      <router-outlet />
    </main>
    <app-confirm-host />
    <app-toast-host />
  `,
})
export class App {
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected immersive(): boolean {
    const url = this.url();
    return /^\/(configurations\/[^/?]+|preview\/)/.test(url);
  }
}
