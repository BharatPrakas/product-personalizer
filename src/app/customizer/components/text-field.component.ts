import { Component, computed, effect, input, output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { FontSpec, TextAlign, TextFieldSpec } from '../models/config.models';
import { FieldError, TextValue } from '../models/draft.models';
import { graphemeCount, normalizeText } from '../util/text-utils';

/** Layer-level style the field falls back to when the customer has not chosen one. */
export interface TextStyleDefaults {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
}

const ALIGNS: readonly { id: TextAlign; label: string }[] = [
  { id: 'left', label: 'Align left' },
  { id: 'center', label: 'Align centre' },
  { id: 'right', label: 'Align right' },
];

/** One configured text field: text box with live count, font picker, colour swatches and style toggles. */
@Component({
  selector: 'app-text-field',
  imports: [ReactiveFormsModule],
  template: `
    <div class="field" [formGroup]="form">
      <label class="label" [for]="id('input')">
        {{ field().label }}
        @if (field().required) {
          <span class="req">(required)</span>
        }
      </label>
      @if (field().helpText) {
        <p class="help" [id]="id('help')">{{ field().helpText }}</p>
      }
      <input
        class="control"
        type="text"
        formControlName="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        [id]="id('input')"
        [placeholder]="field().placeholder ?? ''"
        [attr.aria-required]="field().required"
        [attr.aria-invalid]="errors().length > 0"
        [attr.aria-describedby]="describedBy()"
        (blur)="blurred.emit()"
      />
      <p class="count" [id]="id('count')" [class.count-over]="count() > field().maxLength">
        {{ count() }} / {{ field().maxLength }} characters
      </p>

      @if (fonts().length > 1) {
        <label class="label sub" [for]="id('font')">Font</label>
        <select class="control" formControlName="fontId" [id]="id('font')">
          @for (font of fonts(); track font.id) {
            <option [value]="font.id">{{ font.label ?? font.family }}</option>
          }
        </select>
      }

      @if (field().colors.length > 1) {
        <fieldset class="swatches">
          <legend class="label sub">Colour</legend>
          <div class="swatch-row">
            @for (color of field().colors; track color) {
              <label class="swatch">
                <input
                  type="radio"
                  class="sr-only"
                  [formControl]="form.controls.color"
                  [value]="color"
                  [name]="id('color')"
                />
                <span class="swatch-dot" [style.background-color]="color" aria-hidden="true"></span>
                <span class="sr-only">Colour {{ color }}</span>
              </label>
            }
          </div>
        </fieldset>
      }

      @if (controls().size > 0) {
        <div class="style-row" role="group" [attr.aria-label]="field().label + ' style'">
          @if (controls().has('bold')) {
            <button
              type="button"
              class="btn toggle"
              aria-label="Bold"
              [attr.aria-pressed]="effective().bold"
              [disabled]="disabled()"
              (click)="changed.emit({ bold: !effective().bold })"
            >
              <strong aria-hidden="true">B</strong>
            </button>
          }
          @if (controls().has('italic')) {
            <button
              type="button"
              class="btn toggle"
              aria-label="Italic"
              [attr.aria-pressed]="effective().italic"
              [disabled]="disabled()"
              (click)="changed.emit({ italic: !effective().italic })"
            >
              <em aria-hidden="true">I</em>
            </button>
          }
          @if (controls().has('underline')) {
            <button
              type="button"
              class="btn toggle"
              aria-label="Underline"
              [attr.aria-pressed]="effective().underline"
              [disabled]="disabled()"
              (click)="changed.emit({ underline: !effective().underline })"
            >
              <span class="underlined" aria-hidden="true">U</span>
            </button>
          }
          @if (controls().has('align')) {
            @for (align of aligns; track align.id) {
              <button
                type="button"
                class="btn toggle"
                [attr.aria-label]="align.label"
                [attr.aria-pressed]="effective().align === align.id"
                [disabled]="disabled()"
                (click)="changed.emit({ align: align.id })"
              >
                <span aria-hidden="true">{{
                  align.id === 'left' ? '⇤' : align.id === 'right' ? '⇥' : '↔'
                }}</span>
              </button>
            }
          }
        </div>
      }

      <div class="errors" [id]="id('errors')" aria-live="polite">
        @for (error of errors(); track error.code) {
          <p class="error">
            <span class="error-mark" aria-hidden="true">!</span> {{ error.message }}
          </p>
        }
      </div>
    </div>
  `,
})
export class TextFieldComponent {
  readonly field = input.required<TextFieldSpec>();
  readonly allFonts = input.required<readonly FontSpec[]>();
  readonly value = input.required<TextValue>();
  /** Style of the layer this field feeds; used until the customer picks something. */
  readonly layerStyle = input<TextStyleDefaults>({
    bold: false,
    italic: false,
    underline: false,
    align: 'center',
  });
  /** Errors already filtered for display. */
  readonly errors = input.required<readonly FieldError[]>();
  readonly disabled = input(false);

  readonly changed = output<Partial<TextValue>>();
  readonly blurred = output<void>();

  protected readonly aligns = ALIGNS;
  protected readonly form = new FormGroup({
    text: new FormControl('', { nonNullable: true }),
    fontId: new FormControl('', { nonNullable: true }),
    color: new FormControl('', { nonNullable: true }),
  });

  protected readonly fonts = computed(() => {
    const ids = this.field().fontIds;
    return this.allFonts().filter((font) => ids.includes(font.id));
  });
  protected readonly controls = computed(() => new Set(this.field().styleControls ?? []));
  protected readonly effective = computed(() => {
    const value = this.value();
    const base = this.layerStyle();
    return {
      bold: value.bold ?? base.bold,
      italic: value.italic ?? base.italic,
      underline: value.underline ?? base.underline,
      align: value.align ?? base.align,
    };
  });
  protected readonly count = computed(() => graphemeCount(normalizeText(this.value().text)));
  protected readonly describedBy = computed(() =>
    [this.field().helpText ? this.id('help') : null, this.id('count'), this.id('errors')]
      .filter(Boolean)
      .join(' '),
  );

  constructor() {
    // Model -> form (reset / restore). The user's own typing round-trips through `changed`.
    effect(() => {
      const model = this.value();
      const current = this.form.getRawValue();
      const sameText = normalizeText(current.text) === model.text;
      if (!sameText || current.fontId !== model.fontId || current.color !== model.color) {
        this.form.setValue(
          { text: sameText ? current.text : model.text, fontId: model.fontId, color: model.color },
          { emitEvent: false },
        );
      }
    });
    effect(() => {
      if (this.disabled()) this.form.disable({ emitEvent: false });
      else this.form.enable({ emitEvent: false });
    });

    const controls = this.form.controls;
    controls.text.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((text) => this.changed.emit({ text }));
    controls.fontId.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((fontId) => this.changed.emit({ fontId }));
    controls.color.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((color) => this.changed.emit({ color }));
  }

  protected id(part: string): string {
    return `f-${this.field().id}-${part}`;
  }
}
