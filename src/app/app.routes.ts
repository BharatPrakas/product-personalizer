import { isDevMode } from '@angular/core';
import { CanActivateFn, CanDeactivateFn, Router, Routes } from '@angular/router';
import { inject } from '@angular/core';
import type { EditorPageComponent } from './editor/pages/editor-page.component';

/** Development tools (fixture loader, element contract demo) exist only in development builds. */
const devOnly: CanActivateFn = () =>
  isDevMode() ? true : inject(Router).createUrlTree(['/configurations']);

/** Leaving the editor with unsaved changes asks first. */
const confirmLeave: CanDeactivateFn<EditorPageComponent> = (editor) => editor.confirmLeave();

/** Every area is lazy loaded, so the list does not pay for the editor's code. */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'configurations' },
  {
    path: 'configurations',
    title: 'Configurations · Product Personalizer',
    loadComponent: () =>
      import('./configurations/configurations-page.component').then(
        (m) => m.ConfigurationsPageComponent,
      ),
  },
  {
    path: 'configurations/:id',
    title: 'Editor · Product Personalizer',
    canDeactivate: [confirmLeave],
    loadComponent: () =>
      import('./editor/pages/editor-page.component').then((m) => m.EditorPageComponent),
  },
  {
    path: 'preview/:id',
    title: 'Customer preview · Product Personalizer',
    loadComponent: () =>
      import('./preview/preview-page.component').then((m) => m.PreviewPageComponent),
  },
  {
    path: 'dev',
    title: 'Developer tools',
    canActivate: [devOnly],
    loadComponent: () => import('./dev/dev-tools.component').then((m) => m.DevToolsComponent),
  },
  {
    path: 'dev/element',
    title: 'Custom element contract',
    canActivate: [devOnly],
    loadComponent: () => import('./dev/element-demo.component').then((m) => m.ElementDemoComponent),
  },
  { path: 'editor/:id', redirectTo: 'configurations/:id' },
  { path: 'storefront/:id', redirectTo: 'preview/:id' },
  { path: '**', redirectTo: 'configurations' },
];
