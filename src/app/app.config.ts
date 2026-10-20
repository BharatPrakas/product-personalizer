import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { ConfigurationRepository } from './workspace/configuration-repository';
import { LocalConfigurationRepository } from './workspace/local-configuration-repository.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // Standalone persistence is the browser. A hosted deployment swaps this one provider for an
    // implementation that talks to its API; no component depends on the storage mechanism.
    { provide: ConfigurationRepository, useExisting: LocalConfigurationRepository },
  ],
};
