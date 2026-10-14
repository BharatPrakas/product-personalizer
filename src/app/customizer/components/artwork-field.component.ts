import { NgOptimizedImage } from '@angular/common';
import { Component, effect, input, output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ArtworkFieldSpec } from '../models/config.models';
import { ArtworkValue, FieldError } from '../models/draft.models';

/** Predefined artwork as labelled choice cards with thumbnails (a radio group). */
@Component({
  selector: 'app-artwork-field',
  imports: [ReactiveFormsModule, NgOptimizedImage],
  template: `
    <fieldset
      class="field"
      [disabled]="disabled()"
      [attr.aria-describedby]="field().helpText ? id('help') : null"
    >
      <legend class="label">
        {{ field().label }}
        @if (field().required) {
          <span class="req">(required)</span>
        }
      </legend>
      @if (field().helpText) {
        <p class="help" [id]="id('help')">{{ field().helpText }}</p>
      }
      <div class="cards">
        @if (!field().required) {
          <label class="card">
            <input
              type="radio"
              class="sr-only"
              [formControl]="choice"
              value=""
              [name]="id('choice')"
            />
            <span class="card-thumb card-none" aria-hidden="true">–</span>
            <span class="card-name">None</span>
          </label>
        }
        @for (item of field().choices; track item.id) {
          <label class="card">
            <input
              type="radio"
              class="sr-only"
              [formControl]="choice"
              [value]="item.id"
              [name]="id('choice')"
            />
            <span class="card-thumb">
              <img [ngSrc]="item.thumbnailSrc ?? item.src" width="72" height="72" alt="" />
            </span>
            <span class="card-name">{{ item.label }}</span>
          </label>
        }
      </div>
      <div class="errors" aria-live="polite">
        @for (error of errors(); track error.code) {
          <p class="error">
            <span class="error-mark" aria-hidden="true">!</span> {{ error.message }}
          </p>
        }
      </div>
    </fieldset>
  `,
})
export class ArtworkFieldComponent {
  readonly field = input.required<ArtworkFieldSpec>();
  readonly value = input.required<ArtworkValue>();
  readonly errors = input.required<readonly FieldError[]>();
  readonly disabled = input(false);

  readonly changed = output<string | null>();

  /** `''` stands for "no artwork" (only offered when the field is optional). */
  protected readonly choice = new FormControl('', { nonNullable: true });

  constructor() {
    effect(() => {
      const next = this.value().choiceId ?? '';
      if (this.choice.value !== next) this.choice.setValue(next, { emitEvent: false });
    });
    this.choice.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((id) => this.changed.emit(id === '' ? null : id));
  }

  protected id(part: string): string {
    return `f-${this.field().id}-${part}`;
  }
}
