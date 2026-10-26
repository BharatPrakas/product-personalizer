import { CanDeactivateFn, Routes, TitleStrategy } from '@angular/router';
import { Injectable } from '@angular/core';
import type { EditorPageComponent } from '../editor/pages/editor-page.component';

/** Leaving the editor with unsaved changes asks first. */
const confirmLeave: CanDeactivateFn<EditorPageComponent> = (editor) => editor.confirmLeave();

/** The element must never rename the host page's tab. */
@Injectable()
export class NoTitleStrategy extends TitleStrategy {
  override updateTitle(): void {}
}

/** Routes of `<zb-personalization-admin>`. Every area is lazy loaded. */
export const adminRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'configurations' },
  {
    path: 'configurations',
    loadComponent: () =>
      import('../configurations/configurations-page.component').then(
        (m) => m.ConfigurationsPageComponent,
      ),
  },
  {
    path: 'configurations/:id',
    canDeactivate: [confirmLeave],
    loadComponent: () =>
      import('../editor/pages/editor-page.component').then((m) => m.EditorPageComponent),
  },
  {
    path: 'preview/:id',
    loadComponent: () =>
      import('../preview/preview-page.component').then((m) => m.PreviewPageComponent),
  },
  {
    path: 'mapping',
    loadComponent: () =>
      import('../mapping/mapping-page.component').then((m) => m.MappingPageComponent),
  },
  {
    path: 'mapping/:configId',
    loadComponent: () =>
      import('../mapping/mapping-page.component').then((m) => m.MappingPageComponent),
  },
  { path: '**', redirectTo: 'configurations' },
];
