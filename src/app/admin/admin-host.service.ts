import { Service, signal } from '@angular/core';
import type { ProductRef } from '../customizer/models/admin-element-contract';

/**
 * What the host page told the element: catalog, language, read-only. The element component copies
 * its inputs here so services and pages read them without depending on the component.
 */
@Service()
export class AdminHost {
  /** True inside `<zb-personalization-admin>`; false in the standalone application. */
  readonly embedded = signal(false);
  readonly productCatalog = signal<readonly ProductRef[] | null>(null);
  readonly productSearchUrl = signal<string | null>(null);
  readonly readonly = signal(false);
  readonly allowedAssetOrigins = signal<readonly string[]>([]);
}
