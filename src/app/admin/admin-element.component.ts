import {
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ELEMENT_VERSION } from '../customizer/element-version';
import type {
  AdminPersistence,
  AdminView,
  ProductRef,
} from '../customizer/models/admin-element-contract';
import { coerceBoolean, coerceStringList } from '../customizer/util/coerce';
import { ConfirmHostComponent } from '../ui/confirm-host.component';
import { ToastHostComponent } from '../ui/toast-host.component';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import { AdminEvents } from './admin-events.service';
import { AdminHost } from './admin-host.service';
import {
  type AdminLocation,
  NAVIGATE_HOOK,
  coerceView,
  parseUrl,
  urlFor,
} from './admin-navigation';
import { I18n, TranslatePipe } from './i18n/i18n.service';

const asPersistence = (value: unknown): AdminPersistence | null =>
  value === 'local' || value === 'cloud' ? value : null;
const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * `<zb-personalization-admin>`: the merchant side of product personalization (templates, editor, orders,
 * product mapping, markup library) as one self-contained element.
 *
 * Inputs here are the public contract (`customizer/models/admin-element-contract.ts`); Angular
 * Elements exposes them as properties and kebab-case attributes. Everything renders inside this
 * component's shadow root: the host page's CSS cannot reach in and none of this leaks out. The
 * component sets no host-page state: routing is in memory and the tab title is never touched.
 */
@Component({
  selector: 'app-admin-element',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ConfirmHostComponent,
    ToastHostComponent,
    TranslatePipe,
  ],
  encapsulation: ViewEncapsulation.ShadowDom,
  styleUrl: './admin-element.scss',
  host: {
    '[attr.data-view]': 'current().view',
    '[attr.data-config-id]': 'current().configId',
    '[attr.data-order-id]': 'current().orderId',
  },
  template: `
    <div class="zb-admin" [attr.dir]="i18n.dir()" [attr.lang]="i18n.tag()">
      <a class="skip-link" href="#main" (click)="skipToContent($event)">{{ 'app.skip' | t }}</a>
      @if (!immersive()) {
        <header class="app-header">
          <span class="brand">
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
            <span>{{ 'app.title' | t }}</span>
          </span>
          <nav [attr.aria-label]="'nav.label' | t">
            <a
              routerLink="/configurations"
              routerLinkActive="is-active"
              ariaCurrentWhenActive="page"
            >
              {{ 'nav.templates' | t }}
            </a>
            <a routerLink="/mapping" routerLinkActive="is-active" ariaCurrentWhenActive="page">
              {{ 'nav.mapping' | t }}
            </a>
            <a routerLink="/orders" routerLinkActive="is-active" ariaCurrentWhenActive="page">
              {{ 'nav.orders' | t }}
            </a>
          </nav>
          <span class="grow"></span>
          <span class="storage-chip" [class.storage-chip--local]="storageKind() === 'local'">
            {{ storageKind() === 'cloud' ? ('storage.cloud' | t) : ('storage.local' | t) }}
          </span>
        </header>
      }
      @if (host.readonly()) {
        <p class="notice notice--info readonly-banner" role="status">{{ 'readonly.banner' | t }}</p>
      }
      <main id="main" tabindex="-1" class="app-main" [class.app-main--immersive]="immersive()">
        <router-outlet />
      </main>
      <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
      <app-confirm-host />
      <app-toast-host />
    </div>
  `,
})
export class AdminElementComponent {
  // ---- public inputs (property names are the element's property names) -------------------
  readonly apiBaseUrl = input<string | null, unknown>(null, { transform: asString });
  readonly authToken = input<string | null, unknown>(null, { transform: asString });
  readonly productCatalog = input<readonly ProductRef[] | null>(null);
  readonly productSearchUrl = input<string | null, unknown>(null, { transform: asString });
  readonly view = input<AdminView, unknown>('list', { transform: coerceView });
  readonly configId = input<string | null, unknown>(null, { transform: asString });
  readonly orderId = input<string | null, unknown>(null, { transform: asString });
  // Angular Elements exposes the class field name as the element property, so it must be `readonly`.
  readonly readonly = input<boolean, unknown>(false, { transform: coerceBoolean });
  readonly locale = input<string | null, unknown>(null, { transform: asString });
  readonly allowedAssetOrigins = input<readonly string[], unknown>([], {
    transform: coerceStringList,
  });
  readonly persistence = input<AdminPersistence | null, unknown>(null, {
    transform: asPersistence,
  });

  protected readonly host = inject(AdminHost);
  protected readonly i18n = inject(I18n);
  private readonly router = inject(Router);
  private readonly runtime = inject(RuntimeConfig);
  private readonly events = inject(AdminEvents);
  private readonly repository = inject(ConfigurationRepository);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly current = signal<AdminLocation>({ view: 'list', configId: null, orderId: null });
  protected readonly announcement = signal('');
  protected readonly immersive = computed(
    () => this.current().view === 'editor' || this.current().view === 'preview',
  );
  protected readonly storage = computed(() => this.repository.storage());
  protected readonly storageKind = computed(() => (this.runtime.useCloud() ? 'cloud' : 'local'));

  private static instances = 0;
  private static navigationStarted = false;
  private firstNavigation = true;

  constructor() {
    if (++AdminElementComponent.instances > 1) {
      console.warn(
        '<zb-personalization-admin>: several instances share one session (storage, API and token). Use one element per page.',
      );
    }
    this.host.embedded.set(true);
    this.events.attach(this.element.nativeElement);
    inject(DestroyRef).onDestroy(() => {
      AdminElementComponent.instances--;
      this.events.attach(null);
    });

    // Host properties -> services.
    effect(() => {
      this.i18n.setLocale(this.locale());
    });
    effect(() => {
      this.runtime.update({
        apiBaseUrl: this.apiBaseUrl() ?? undefined,
        authToken: this.authToken() ?? undefined,
        persistence: this.persistence() ?? undefined,
      });
    });
    effect(() => {
      this.host.productCatalog.set(this.productCatalog());
      this.host.productSearchUrl.set(this.productSearchUrl());
      this.host.readonly.set(this.readonly());
      this.host.allowedAssetOrigins.set(this.allowedAssetOrigins());
    });

    // Deep links: `view` / `config-id` -> in-memory router.
    effect(() => {
      this.view();
      this.configId();
      this.orderId();
      untracked(() => this.followInputs());
    });
    // The element class calls this on every assignment, including repeats of the same value.
    (this.element.nativeElement as unknown as Record<symbol, () => void>)[NAVIGATE_HOOK] = () =>
      this.followInputs();

    // Router -> host: data-view attributes, view-change, screen-reader announcement, focus.
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.onNavigated(e.urlAfterRedirects));

    // Components in the router outlet are created by the router, but nothing bootstraps a router
    // for a custom element, so start navigation once.
    if (!AdminElementComponent.navigationStarted) {
      AdminElementComponent.navigationStarted = true;
      this.router.initialNavigation();
    }
  }

  private followInputs(): void {
    const url = urlFor(this.view(), this.configId(), this.orderId());
    if (this.router.url !== url) void this.router.navigateByUrl(url);
  }

  private onNavigated(url: string): void {
    const next = parseUrl(url);
    const previous = this.current();
    if (
      previous.view !== next.view ||
      previous.configId !== next.configId ||
      previous.orderId !== next.orderId
    ) {
      this.current.set(next);
      this.events.viewChange(next);
    }
    this.announcement.set(
      this.i18n.t('route.announce', { view: this.i18n.t(`view.${next.view}`) }),
    );
    if (this.firstNavigation) {
      this.firstNavigation = false;
      this.events.emit('admin-ready', {
        version: ELEMENT_VERSION,
        persistence: this.runtime.useCloud() ? 'cloud' : 'local',
      });
      return;
    }
    // Focus management: after a view change, move focus to the new page's heading.
    setTimeout(() => this.focusHeading());
  }

  private focusHeading(): void {
    const root = this.element.nativeElement.shadowRoot;
    const heading = root?.querySelector<HTMLElement>('main h1');
    const target = heading ?? root?.querySelector<HTMLElement>('main');
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: false });
  }

  protected skipToContent(event: Event): void {
    event.preventDefault();
    this.element.nativeElement.shadowRoot?.querySelector<HTMLElement>('#main')?.focus();
  }
}
