/**
 * Entry point of the custom-element bundle: registers <zb-product-customizer>.
 *
 * - Zoneless: the bundle ships without Zone.js, so it never patches the host page's globals.
 * - No global error listeners are installed (provideBrowserGlobalErrorListeners would hook the
 *   host page's `error` / `unhandledrejection` events, which an embedded widget must not do).
 * - Registration is guarded: importing the module again (same or different URL) neither
 *   bootstraps a second Angular application nor replaces an existing implementation.
 */

import { createCustomElement } from '@angular/elements';
import { CSP_NONCE, provideZonelessChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { ELEMENT_VERSION } from './app/customizer/element-version';
import { CUSTOMIZER_TAG } from './app/customizer/models/element-contract';
import { PREPARE_HOOK, ProductCustomizerComponent } from './app/customizer/product-customizer.component';

interface Registration {
  version: string;
  ready: Promise<void>;
}

const REGISTRATION_KEY = Symbol.for('zb-product-customizer.registration');
type RegistryHost = typeof globalThis & { [REGISTRATION_KEY]?: Registration };

export function registerProductCustomizer(): Promise<void> {
  const host = globalThis as RegistryHost;
  const existing = host[REGISTRATION_KEY];
  if (existing) {
    if (existing.version !== ELEMENT_VERSION) {
      console.warn(
        `<${CUSTOMIZER_TAG}> is already registered by bundle ${existing.version}; ignoring bundle ${ELEMENT_VERSION}. ` +
          'Load one bundle version per page.',
      );
    }
    return existing.ready;
  }
  if (customElements.get(CUSTOMIZER_TAG)) {
    console.warn(
      `<${CUSTOMIZER_TAG}> is already defined by another implementation; leaving it untouched.`,
    );
    return Promise.resolve();
  }

  const ready = (async () => {
    // Hosts with a strict style-src can publish their nonce as <meta name="csp-nonce" content="...">;
    // it is applied to the style elements the element adds inside its shadow root.
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    const app = await createApplication({
      providers: [
        provideZonelessChangeDetection(),
        ...(nonce ? [{ provide: CSP_NONCE, useValue: nonce }] : []),
      ],
    });
    customElements.define(
      CUSTOMIZER_TAG,
      withPrepareForCart(
        createCustomElement(ProductCustomizerComponent, { injector: app.injector }) as unknown as CustomElementConstructor,
      ),
    );
  })();
  host[REGISTRATION_KEY] = { version: ELEMENT_VERSION, ready };
  ready.catch((error: unknown) => {
    delete host[REGISTRATION_KEY]; // allow a later retry
    console.error(`Failed to register <${CUSTOMIZER_TAG}>`, error);
  });
  return ready;
}

type Hooked = { [PREPARE_HOOK]?: () => Promise<Readonly<Record<string, string>>> };

/**
 * Adds the contract's `prepareForCart()` command. Angular Elements exports inputs and outputs but not
 * methods, so the component publishes the implementation under a well-known symbol on its host element
 * and this wrapper forwards to it. Before the element has connected (no component yet) it rejects with a
 * message that is safe to show.
 */
function withPrepareForCart(Base: CustomElementConstructor): CustomElementConstructor {
  class StorefrontElement extends Base {
    prepareForCart(): Promise<Readonly<Record<string, string>>> {
      const prepare = (this as unknown as Hooked)[PREPARE_HOOK];
      return prepare
        ? prepare()
        : Promise.reject(new Error('Personalization is still loading. Please wait a moment.'));
    }
  }
  return StorefrontElement;
}
