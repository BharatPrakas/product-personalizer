import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { TranslatePipe } from '../admin/i18n/i18n.service';
import { IconComponent } from './icon.component';

/**
 * A modal dialog on the native `<dialog>` element, so focus is trapped, Escape closes it and the
 * rest of the page is inert. Content is projected; actions go in the `[dialogActions]` slot.
 */
@Component({
  selector: 'app-dialog',
  imports: [IconComponent, TranslatePipe],
  template: `
    <dialog
      #dialog
      class="dialog"
      [style.width.px]="width()"
      [attr.aria-labelledby]="titleId"
      (cancel)="onCancel($event)"
      (click)="onBackdrop($event)"
    >
      <div class="dialog-body">
        <header class="dialog-header">
          <h2 [id]="titleId" class="dialog-title">{{ title() }}</h2>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            [attr.aria-label]="'ui.close-dialog' | t"
            (click)="requestClose()"
          >
            <app-icon name="close" />
          </button>
        </header>
        @if (description(); as text) {
          <p class="muted">{{ text }}</p>
        }
        <div class="dialog-content">
          <ng-content />
        </div>
        <footer class="dialog-actions">
          <ng-content select="[dialogActions]" />
        </footer>
      </div>
    </dialog>
  `,
})
export class DialogComponent {
  private static nextId = 0;
  protected readonly titleId = `dialog-title-${++DialogComponent.nextId}`;

  readonly open = input(false);
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
  readonly width = input(480);
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.open() && !el.open) el.showModal();
      else if (!this.open() && el.open) el.close();
    });
  }

  protected requestClose(): void {
    this.closed.emit();
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    this.closed.emit();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.closed.emit();
  }
}
