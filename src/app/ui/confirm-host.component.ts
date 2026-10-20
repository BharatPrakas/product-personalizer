import { Component, inject } from '@angular/core';
import { ConfirmService } from './confirm.service';
import { DialogComponent } from './dialog.component';

@Component({
  selector: 'app-confirm-host',
  imports: [DialogComponent],
  template: `
    @let request = confirm.pending();
    <app-dialog
      [open]="request !== null"
      [title]="request?.title ?? ''"
      [width]="440"
      (closed)="confirm.answer(false)"
    >
      <p>{{ request?.message }}</p>
      <ng-container dialogActions>
        <button type="button" class="btn" (click)="confirm.answer(false)">
          {{ request?.cancelLabel ?? 'Cancel' }}
        </button>
        <button
          type="button"
          class="btn"
          [class.btn--primary]="!request?.danger"
          [class.btn--danger]="request?.danger"
          (click)="confirm.answer(true)"
        >
          {{ request?.confirmLabel }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class ConfirmHostComponent {
  protected readonly confirm = inject(ConfirmService);
}
