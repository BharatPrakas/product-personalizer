import { Routes } from '@angular/router';

/** Every feature is lazy loaded, so the product list does not pay for the editor's code. */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Products - Product Personalizer',
    loadComponent: () =>
      import('./editor/pages/products-page.component').then((m) => m.ProductsPageComponent),
  },
  {
    path: 'editor/:id',
    title: 'Editor - Product Personalizer',
    loadComponent: () =>
      import('./editor/pages/editor-page.component').then((m) => m.EditorPageComponent),
  },
  {
    path: 'storefront/:id',
    title: 'Storefront - Product Personalizer',
    loadComponent: () =>
      import('./editor/pages/storefront-page.component').then((m) => m.StorefrontPageComponent),
  },
  {
    path: 'element-demo',
    title: 'Custom element demo',
    loadComponent: () =>
      import('./pages/element-demo.component').then((m) => m.ElementDemoComponent),
  },
  { path: '**', redirectTo: '' },
];
