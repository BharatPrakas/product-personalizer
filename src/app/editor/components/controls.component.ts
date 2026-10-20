import { Component, computed, input, output } from '@angular/core';

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;

/** Labelled numeric input that reports every valid change (so edits update the stage live). */
@Component({
  selector: 'app-num',
  template: `
    <label class="field">
      <span class="field-label">{{ label() }}</span>
      <input
        class="input"
        type="number"
        inputmode="decimal"
        [value]="value() ?? ''"
        [attr.min]="min()"
        [attr.max]="max()"
        [attr.step]="step()"
        [disabled]="disabled()"
        (input)="onInput($event)"
      />
    </label>
  `,
})
export class NumComponent {
  readonly label = input.required<string>();
  readonly value = input<number | null>(null);
  readonly min = input<number | null>(null);
  readonly max = input<number | null>(null);
  readonly step = input<number | string>(1);
  readonly disabled = input(false);
  readonly changed = output<number>();

  protected onInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    if (raw === '') return;
    let n = Number(raw);
    if (!Number.isFinite(n)) return;
    const min = this.min();
    const max = this.max();
    if (min !== null && n < min) n = min;
    if (max !== null && n > max) n = max;
    this.changed.emit(n);
  }
}

@Component({
  selector: 'app-text-in',
  template: `
    <label class="field">
      <span class="field-label">{{ label() }}</span>
      @if (multiline()) {
        <textarea
          class="input"
          rows="3"
          [value]="value()"
          [attr.maxlength]="maxlength()"
          [attr.placeholder]="placeholder() || null"
          [disabled]="disabled()"
          (input)="onInput($event)"
        ></textarea>
      } @else {
        <input
          class="input"
          type="text"
          [value]="value()"
          [attr.maxlength]="maxlength()"
          [attr.placeholder]="placeholder() || null"
          [disabled]="disabled()"
          (input)="onInput($event)"
        />
      }
    </label>
  `,
})
export class TextInComponent {
  readonly label = input.required<string>();
  readonly value = input('');
  readonly placeholder = input('');
  readonly maxlength = input<number | null>(null);
  readonly multiline = input(false);
  readonly disabled = input(false);
  readonly changed = output<string>();

  protected onInput(event: Event): void {
    this.changed.emit((event.target as HTMLInputElement | HTMLTextAreaElement).value);
  }
}

@Component({
  selector: 'app-check',
  template: `
    <label class="check">
      <input
        type="checkbox"
        [checked]="value()"
        [disabled]="disabled()"
        (change)="changed.emit($any($event.target).checked)"
      />
      <span>{{ label() }}</span>
    </label>
  `,
})
export class CheckComponent {
  readonly label = input.required<string>();
  readonly value = input(false);
  readonly disabled = input(false);
  readonly changed = output<boolean>();
}

export interface Option {
  value: string;
  label: string;
}

@Component({
  selector: 'app-select',
  template: `
    <label class="field">
      <span class="field-label">{{ label() }}</span>
      <select
        class="input"
        [disabled]="disabled()"
        (change)="changed.emit($any($event.target).value)"
      >
        @for (option of options(); track option.value) {
          <option [value]="option.value" [selected]="option.value === value()">
            {{ option.label }}
          </option>
        }
      </select>
    </label>
  `,
})
export class SelectComponent {
  readonly label = input.required<string>();
  readonly options = input.required<readonly Option[]>();
  readonly value = input<string | null>('');
  readonly disabled = input(false);
  readonly changed = output<string>();
}

/** Colour picker with an optional "transparent" switch. Values are `#rrggbb` or `transparent`. */
@Component({
  selector: 'app-color',
  template: `
    <div class="field">
      <label class="field-label" [for]="id">{{ label() }}</label>
      <div class="row row--end">
        <input
          class="color-input"
          type="color"
          [id]="id"
          [value]="hex()"
          [disabled]="disabled() || value() === 'transparent'"
          (input)="changed.emit($any($event.target).value)"
        />
        @if (allowTransparent()) {
          <label class="check">
            <input
              type="checkbox"
              [checked]="value() === 'transparent'"
              [disabled]="disabled()"
              (change)="changed.emit($any($event.target).checked ? 'transparent' : hex())"
            />
            <span>None</span>
          </label>
        }
      </div>
    </div>
  `,
})
export class ColorComponent {
  protected readonly id = uid('color');
  readonly label = input.required<string>();
  readonly value = input('#000000');
  readonly allowTransparent = input(false);
  readonly disabled = input(false);
  readonly changed = output<string>();
  protected readonly hex = computed(() => {
    const v = this.value();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#000000';
  });
}

/** A file button; emits the chosen file and resets so the same file can be chosen again. */
@Component({
  selector: 'app-file',
  template: `
    <label class="btn" [class.is-disabled]="disabled()">
      <span>{{ label() }}</span>
      <input
        class="sr-only"
        type="file"
        [accept]="accept()"
        [disabled]="disabled()"
        (change)="onChange($event)"
      />
    </label>
  `,
})
export class FileComponent {
  readonly label = input.required<string>();
  readonly accept = input('image/png,image/jpeg,image/webp');
  readonly disabled = input(false);
  readonly chosen = output<File>();

  protected onChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.chosen.emit(file);
  }
}

export const CONTROLS = [
  NumComponent,
  TextInComponent,
  CheckComponent,
  SelectComponent,
  ColorComponent,
  FileComponent,
] as const;
