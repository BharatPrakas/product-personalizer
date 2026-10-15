import { Component, inject } from '@angular/core';
import { EditorStore } from '../services/editor-store.service';
import { AreaPropsComponent } from './area-props.component';
import { ArtworkPropsComponent } from './artwork-props.component';
import { LayerPropsComponent } from './layer-props.component';
import { MockupPropsComponent } from './mockup-props.component';
import { ProductPropsComponent } from './product-props.component';

/** Right panel: shows the properties for whatever is selected. */
@Component({
  selector: 'app-properties-panel',
  imports: [
    ProductPropsComponent,
    MockupPropsComponent,
    AreaPropsComponent,
    ArtworkPropsComponent,
    LayerPropsComponent,
  ],
  template: `
    @switch (store.selection().kind) {
      @case ('layer') {
        <app-layer-props />
      }
      @case ('area') {
        <app-area-props />
      }
      @case ('artwork') {
        <app-artwork-props />
      }
      @case ('mockup') {
        <app-mockup-props />
      }
      @default {
        <app-product-props />
      }
    }
  `,
})
export class PropertiesPanelComponent {
  protected readonly store = inject(EditorStore);
}
