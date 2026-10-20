import { Component, input } from '@angular/core';
import { IconComponent, IconName } from './icon.component';

@Component({
  selector: 'app-empty-state',
  imports: [IconComponent],
  template: `
    <div class="empty-state">
      <span class="empty-state-icon"><app-icon [name]="icon()" [size]="26" /></span>
      <h2 class="empty-state-title">{{ title() }}</h2>
      @if (description(); as text) {
        <p class="muted empty-state-text">{{ text }}</p>
      }
      <div class="row empty-state-actions"><ng-content /></div>
    </div>
  `,
})
export class EmptyStateComponent {
  readonly icon = input<IconName>('layers');
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
}
