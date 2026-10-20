import { Component, inject } from '@angular/core';
import { IconComponent } from './icon.component';
import { ToastService } from './toast.service';

@Component({
  selector: 'app-toast-host',
  imports: [IconComponent],
  template: `
    <div class="toast-region" role="status" aria-live="polite">
      @for (toast of toasts.toasts(); track toast.id) {
        <div class="toast" [class]="'toast toast--' + toast.kind">
          <app-icon
            [name]="
              toast.kind === 'error' ? 'alert' : toast.kind === 'success' ? 'circle-check' : 'info'
            "
          />
          <span class="grow">{{ toast.message }}</span>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            aria-label="Dismiss message"
            (click)="toasts.dismiss(toast.id)"
          >
            <app-icon name="close" [size]="16" />
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastHostComponent {
  protected readonly toasts = inject(ToastService);
}
