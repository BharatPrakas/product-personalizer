/**
 * Registers <zb-personalization-admin>.
 *
 * - Zoneless: no Zone.js, so the host page's globals are never patched.
 * - No global error listeners (provideBrowserGlobalErrorListeners would hook the host's
 *   `error` / `unhandledrejection` events).
 * - The router runs in memory: the element never reads or writes the host's URL or history, and
 *   never sets the document title.
 * - Registration is guarded: loading the bundle again (same or different URL) neither bootstraps a
 *   second Angular application nor replaces an existing implementation.
 */

import { provideHttpClient, withFetch } from '@angular/common/http';
import { LocationStrategy } from '@angular/common';
import { createCustomElement } from '@angular/elements';
import { CSP_NONCE, provideZonelessChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { TitleStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { AdminConfigurationRepository } from './app/admin/admin-config-repository';
import { AdminElementComponent } from './app/admin/admin-element.component';
import { NAVIGATE_HOOK } from './app/admin/admin-navigation';
import { MemoryLocationStrategy } from './app/admin/memory-location-strategy';
import { NoTitleStrategy, adminRoutes } from './app/admin/admin.routes';
import { ELEMENT_VERSION } from './app/customizer/element-version';
import { ADMIN_TAG } from './app/customizer/models/admin-element-contract';
import { ConfigurationRepository } from './app/workspace/configuration-repository';
import { AdminProductMappingRepository } from './app/mapping/admin-product-mapping-repository';
import { ProductMappingRepository } from './app/mapping/product-mapping-repository';
import { AdminOrderRepository } from './app/orders/admin-order-repository';
import { OrderRepository } from './app/orders/order-repository';
import { AdminMarkupRepository } from './app/markups/admin-markup-repository';
import { MarkupRepository } from './app/markups/markup-repository';
import { AdminFontRepository } from './app/fonts/admin-font-repository';
import { FontRepository } from './app/fonts/font-repository';
import { setAssetBaseUrl } from './app/workspace/asset-base';

interface Registration {
  version: string;
  ready: Promise<void>;
}

const REGISTRATION_KEY = Symbol.for('zb-personalization-admin.registration');
type RegistryHost = typeof globalThis & { [REGISTRATION_KEY]?: Registration };

export function registerPersonalizationAdmin(): Promise<void> {
  const host = globalThis as RegistryHost;
  const existing = host[REGISTRATION_KEY];
  if (existing) {
    if (existing.version !== ELEMENT_VERSION) {
      console.warn(
        `<${ADMIN_TAG}> is already registered by bundle ${existing.version}; ignoring bundle ${ELEMENT_VERSION}. ` +
          'Load one bundle version per page.',
      );
    }
    return existing.ready;
  }
  if (customElements.get(ADMIN_TAG)) {
    console.warn(
      `<${ADMIN_TAG}> is already defined by another implementation; leaving it untouched.`,
    );
    return Promise.resolve();
  }

  const ready = (async () => {
    // Bundled fonts and sample images sit next to this script, not next to the host page.
    setAssetBaseUrl(new URL('.', import.meta.url).href);
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    const app = await createApplication({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withFetch()),
        provideRouter(adminRoutes, withComponentInputBinding()),
        { provide: LocationStrategy, useClass: MemoryLocationStrategy },
        { provide: TitleStrategy, useClass: NoTitleStrategy },
        { provide: ConfigurationRepository, useExisting: AdminConfigurationRepository },
        { provide: ProductMappingRepository, useExisting: AdminProductMappingRepository },
        { provide: OrderRepository, useExisting: AdminOrderRepository },
        { provide: MarkupRepository, useExisting: AdminMarkupRepository },
        { provide: FontRepository, useExisting: AdminFontRepository },
        ...(nonce ? [{ provide: CSP_NONCE, useValue: nonce }] : []),
      ],
    });
    const Base = createCustomElement(AdminElementComponent, { injector: app.injector });
    customElements.define(
      ADMIN_TAG,
      withNavigationCommands(Base as unknown as CustomElementConstructor),
    );
  })();
  host[REGISTRATION_KEY] = { version: ELEMENT_VERSION, ready };
  ready.catch((error: unknown) => {
    delete host[REGISTRATION_KEY]; // allow a later retry
    console.error(`Failed to register <${ADMIN_TAG}>`, error);
  });
  return ready;
}

type Hooked = { [NAVIGATE_HOOK]?: () => void };
type AttributeCallback = (
  this: HTMLElement,
  name: string,
  old: string | null,
  value: string | null,
  ns?: string,
) => void;

/**
 * `view`, `config-id` and `order-id` act as navigation commands: assigning them always navigates, even when
 * the value equals the one the host assigned before (the merchant may have moved elsewhere since).
 * Angular Elements skips repeated equal assignments, so the element class re-triggers the router.
 */
function withNavigationCommands(Base: CustomElementConstructor): CustomElementConstructor {
  const poke = (el: object) => queueMicrotask(() => (el as Hooked)[NAVIGATE_HOOK]?.());
  class AdminElement extends Base {}

  const attributeChanged = (
    Base.prototype as unknown as { attributeChangedCallback: AttributeCallback }
  ).attributeChangedCallback;
  (
    AdminElement.prototype as unknown as { attributeChangedCallback: AttributeCallback }
  ).attributeChangedCallback = function (name, old, value, ns) {
    attributeChanged.call(this, name, old, value, ns);
    if (name === 'view' || name === 'config-id' || name === 'order-id') poke(this);
  };

  for (const prop of ['view', 'configId', 'orderId']) {
    const original = Object.getOwnPropertyDescriptor(Base.prototype, prop);
    if (!original?.set) continue;
    Object.defineProperty(AdminElement.prototype, prop, {
      configurable: true,
      enumerable: true,
      get: original.get,
      set(this: object, value: unknown) {
        original.set!.call(this, value);
        poke(this);
      },
    });
  }
  return AdminElement;
}
