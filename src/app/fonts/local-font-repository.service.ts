import { Service } from '@angular/core';
import { FontRepository } from './font-repository';
import { FontLibraryUnavailableOfflineError, type CustomFont } from './font.models';

/**
 * No custom font library offline. Uploading needs the Worker's content sniffing and store-scoped
 * storage, which the standalone/local-only app has no equivalent for — see
 * docs/extension-platform-contract-v1.md for why this feature is cloud-only. The 4 bundled default
 * fonts are unaffected: they come from `empty-configuration.ts`, not from this repository.
 */
@Service()
export class LocalFontRepository extends FontRepository {
  async list(): Promise<CustomFont[]> {
    return [];
  }

  async upload(): Promise<CustomFont> {
    throw new FontLibraryUnavailableOfflineError();
  }

  async delete(): Promise<void> {
    throw new FontLibraryUnavailableOfflineError();
  }
}
