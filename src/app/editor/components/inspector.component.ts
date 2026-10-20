import { Component, inject } from '@angular/core';
import { EditorStore } from '../services/editor-store.service';
import { AreaPropsComponent } from './area-props.component';
import { ArtworkPropsComponent } from './artwork-props.component';
import { ConfigurationInspectorComponent } from './configuration-inspector.component';
import { LayerPropsComponent } from './layer-props.component';
import { MockupPropsComponent } from './mockup-props.component';

/** Right sidebar: properties of whatever is selected. */
@Component({
  selector: 'app-inspector',
  imports: [
    ConfigurationInspectorComponent,
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
        <app-configuration-inspector />
      }
    }
  `,
})
export class InspectorComponent {
  protected readonly store = inject(EditorStore);
}
