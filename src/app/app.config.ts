import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { ConfigurationRepository } from './workspace/configuration-repository';
import { LocalConfigurationRepository } from './workspace/local-configuration-repository.service';
import { CloudConfigurationRepository } from './workspace/cloud/cloud-configuration-repository.service';
import { RuntimeConfig } from './workspace/cloud/runtime-config';
import { LocalProductMappingRepository } from './mapping/local-product-mapping-repository.service';
import { ProductMappingRepository } from './mapping/product-mapping-repository';
import { LocalMarkupRepository } from './markups/local-markup-repository.service';
import { MarkupRepository } from './markups/markup-repository';
import { CloudFontRepository } from './fonts/cloud-font-repository.service';
import { LocalFontRepository } from './fonts/local-font-repository.service';
import { FontRepository } from './fonts/font-repository';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    // Persistence is chosen at runtime. The standalone app ships no runtime config, so it stays on
    // the browser (IndexedDB) implementation — unchanged. A hosted deployment that sets
    // `window.__ZB_PERSONALIZER__ = { apiBaseUrl, authToken }` switches to the cloud repository, and
    // no component depends on which one is active. (See workspace/cloud/runtime-config.ts.)
    // The standalone app keeps mappings in the browser; the admin element switches per call.
    { provide: ProductMappingRepository, useExisting: LocalProductMappingRepository },
    { provide: MarkupRepository, useExisting: LocalMarkupRepository },
    {
      provide: ConfigurationRepository,
      useFactory: () =>
        inject(RuntimeConfig).useCloud()
          ? inject(CloudConfigurationRepository)
          : inject(LocalConfigurationRepository),
    },
    // Custom fonts are cloud-only (there is no offline equivalent of the Worker's store-scoped
    // library — see fonts/local-font-repository.service.ts); the bundled defaults are unaffected.
    {
      provide: FontRepository,
      useFactory: () => (inject(RuntimeConfig).useCloud() ? inject(CloudFontRepository) : inject(LocalFontRepository)),
    },
  ],
};
