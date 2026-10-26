import { Component, effect, inject, signal } from '@angular/core';
import { I18n, TranslatePipe } from '../admin/i18n/i18n.service';
import { DialogComponent } from '../ui/dialog.component';
import { MarkupInvalidError, MarkupNameTakenError } from './markup.models';
import { MarkupLibrary } from './markup-library.service';

/** Asks for a name and stores the captured area / artwork in the library. */
@Component({
  selector: 'app-save-markup-dialog',
  imports: [DialogComponent, TranslatePipe],
  template: `
    <app-dialog
      [open]="library.saveRequest() !== null"
      [title]="'markups.save-as' | t"
      [width]="420"
      (closed)="library.saveRequest.set(null)"
    >
      <form id="save-markup-form" (submit)="submit($event)">
        <label class="field">
          <span class="label">{{ 'markups.name' | t }}</span>
          <input
            class="input"
            type="text"
            maxlength="120"
            required
            [value]="name()"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="error() ? 'save-markup-error' : null"
            (input)="name.set($any($event.target).value)"
          />
        </label>
        @if (error()) {
          <p id="save-markup-error" class="field-error" role="alert">{{ error() }}</p>
        }
      </form>
      <ng-container dialogActions>
        <button type="button" class="btn" (click)="library.saveRequest.set(null)">
          {{ 'common.cancel' | t }}
        </button>
        <button type="submit" form="save-markup-form" class="btn btn--primary" [disabled]="busy()">
          {{ 'common.save' | t }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class SaveMarkupDialogComponent {
  protected readonly library = inject(MarkupLibrary);
  private readonly i18n = inject(I18n);
  protected readonly name = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      const request = this.library.saveRequest();
      this.name.set(request?.suggestedName ?? '');
      this.error.set('');
    });
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    try {
      await this.library.save(this.name());
    } catch (error) {
      this.error.set(
        error instanceof MarkupNameTakenError
          ? this.i18n.t('markups.name-taken')
          : error instanceof MarkupInvalidError
            ? error.message
            : this.i18n.t('markups.error'),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
