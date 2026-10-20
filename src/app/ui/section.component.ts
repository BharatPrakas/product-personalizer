import { Component, input } from '@angular/core';
import { IconComponent } from './icon.component';

/** A collapsible group in the inspector, on the native `<details>` element (keyboard and screen-reader friendly). */
@Component({
  selector: 'app-section',
  imports: [IconComponent],
  template: `
    <details class="section" [open]="open()">
      <summary class="section-summary">
        <span class="section-title">{{ title() }}</span>
        <app-icon class="section-chevron" name="chevron-down" [size]="16" />
      </summary>
      <div class="section-body stack">
        <ng-content />
      </div>
    </details>
  `,
})
export class SectionComponent {
  readonly title = input.required<string>();
  readonly open = input(true);
}
