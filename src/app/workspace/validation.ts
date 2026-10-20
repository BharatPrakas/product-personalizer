import { validateProductConfig } from '../customizer/util/product-validator';
import { resolveBase } from '../customizer/util/url-policy';

export interface ValidationMode {
  /** Drafts may still be empty; published configurations may not. */
  allowIncomplete: boolean;
}

/**
 * Validate a configuration the way the storefront does, with browser-stored images (`idb:`)
 * allowed because this application keeps them in IndexedDB.
 */
export function validateConfiguration(raw: unknown, mode: ValidationMode) {
  return validateProductConfig(raw, {
    resolvedBase: resolveBase({ configUrl: null, baseUrl: null, documentBase: document.baseURI }),
    policy: { pageOrigin: location.origin, allowedOrigins: [], allowLocalAssets: true },
    allowIncomplete: mode.allowIncomplete,
  });
}
