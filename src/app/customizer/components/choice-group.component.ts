import { Component, input, output } from '@angular/core';

export interface Choice {
  id: string;
  label: string;
  /** Optional colour chip. */
  swatch?: string;
}

/** A small radio group rendered as buttons: variants, artwork alternatives. Keyboard accessible. */
@Component({
  selector: 'app-choice-group',
  template: `
    <fieldset class="field">
      <legend class="label">{{ legend() }}</legend>
      <div class="chip-row">
        @for (choice of choices(); track choice.id) {
          <label class="chip" [class.chip-selected]="choice.id === selected()">
            <input
              type="radio"
              class="sr-only"
              [name]="name()"
              [value]="choice.id"
              [checked]="choice.id === selected()"
              [disabled]="disabled()"
              (change)="picked.emit(choice.id)"
            />
            @if (choice.swatch) {
              <span
                class="chip-dot"
                [style.background-color]="choice.swatch"
                aria-hidden="true"
              ></span>
            }
            <span>{{ choice.label }}</span>
          </label>
        }
      </div>
    </fieldset>
  `,
})
export class ChoiceGroupComponent {
  readonly legend = input.required<string>();
  readonly name = input.required<string>();
  readonly choices = input.required<readonly Choice[]>();
  readonly selected = input<string | null>(null);
  readonly disabled = input(false);

  readonly picked = output<string>();
}
