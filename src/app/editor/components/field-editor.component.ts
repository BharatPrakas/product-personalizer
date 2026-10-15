import { Component, computed, inject, input } from '@angular/core';
import {
  AcceptedImageType,
  FieldSpec,
  ImageFieldSpec,
  TextFieldSpec,
  TextStyleControl,
} from '../../customizer/models/config.models';
import { Condition } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';

type RuleMode = 'always' | 'artwork' | 'filled' | 'variant' | 'advanced';

/**
 * Edits the customer-facing definition of a field: label, validation, formats, fonts, colours and
 * the declarative "show when" rule. The binding between a layer and its field lives on the layer.
 */
@Component({
  selector: 'app-field-editor',
  imports: [CONTROLS],
  template: `
    @if (field(); as f) {
      <section class="ed-group" [attr.aria-label]="'Customer field ' + f.label">
        <h4 class="ed-subtitle">
          Customer field <code>{{ f.id }}</code>
        </h4>
        <app-text-in
          label="Label"
          [value]="f.label"
          [maxlength]="80"
          (changed)="patch({ label: $event || f.label })"
        />
        <app-text-in
          label="Help text"
          [value]="f.helpText ?? ''"
          [maxlength]="240"
          (changed)="patch({ helpText: $event || undefined })"
        />
        <app-text-in
          label="Placeholder"
          [value]="f.placeholder ?? ''"
          [maxlength]="80"
          (changed)="patch({ placeholder: $event || undefined })"
        />
        <div class="ed-row">
          <app-check
            label="Required"
            [value]="f.required"
            (changed)="patch({ required: $event }, true)"
          />
          <app-check
            label="Show input"
            [value]="f.visible !== false"
            (changed)="patch({ visible: $event ? undefined : false }, true)"
          />
        </div>

        @switch (f.type) {
          @case ('text') {
            <app-num
              label="Maximum characters"
              [value]="text(f).maxLength"
              [min]="1"
              [max]="500"
              (changed)="patch({ maxLength: $event })"
            />
            <fieldset class="ed-fieldset">
              <legend class="ed-label">Fonts the customer can choose</legend>
              @for (font of store.config()!.fonts; track font.id) {
                <app-check
                  [label]="font.label ?? font.family"
                  [value]="text(f).fontIds.includes(font.id)"
                  (changed)="toggleFont(f.id, font.id, $event)"
                />
              }
            </fieldset>
            <fieldset class="ed-fieldset">
              <legend class="ed-label">Colours</legend>
              <div class="ed-swatches">
                @for (color of text(f).colors; track color) {
                  <button
                    type="button"
                    class="ed-swatch"
                    [style.background-color]="color"
                    [attr.aria-label]="'Remove colour ' + color"
                    title="Remove"
                    (click)="removeColor(f.id, color)"
                  ></button>
                }
                <input
                  class="ed-color"
                  type="color"
                  aria-label="Add a colour"
                  #picker
                  (change)="addColor(f.id, picker.value)"
                />
              </div>
            </fieldset>
            <app-text-in
              label="Default text"
              [value]="text(f).defaultValue?.text ?? ''"
              [maxlength]="text(f).maxLength"
              (changed)="setDefault(f.id, { text: $event })"
            />
            <app-select
              label="Default font"
              [options]="fontOptions(f)"
              [value]="text(f).defaultValue?.fontId ?? text(f).fontIds[0]"
              (changed)="setDefault(f.id, { fontId: $event })"
            />
            <app-select
              label="Default colour"
              [options]="colorOptions(f)"
              [value]="text(f).defaultValue?.color ?? text(f).colors[0]"
              (changed)="setDefault(f.id, { color: $event })"
            />
            <fieldset class="ed-fieldset">
              <legend class="ed-label">Style controls for the customer</legend>
              @for (control of styleControls; track control) {
                <app-check
                  [label]="control"
                  [value]="(text(f).styleControls ?? []).includes(control)"
                  (changed)="toggleStyle(f.id, control, $event)"
                />
              }
            </fieldset>
          }
          @case ('image') {
            <fieldset class="ed-fieldset">
              <legend class="ed-label">Accepted formats</legend>
              @for (type of imageTypes; track type.value) {
                <app-check
                  [label]="type.label"
                  [value]="(image(f).accept ?? defaultAccept).includes(type.value)"
                  (changed)="toggleAccept(f.id, type.value, $event)"
                />
              }
            </fieldset>
            <app-num
              label="Maximum file size (MB)"
              [value]="(image(f).maxBytes ?? 10485760) / 1048576"
              [min]="1"
              [max]="10"
              step="0.5"
              (changed)="patch({ maxBytes: Math.round($event * 1048576) })"
            />
            <div class="ed-row">
              <app-num
                label="Min. width (px)"
                [value]="image(f).minPixels?.width ?? 0"
                [min]="0"
                [max]="20000"
                (changed)="setMinPixels(f.id, { width: $event })"
              />
              <app-num
                label="Min. height (px)"
                [value]="image(f).minPixels?.height ?? 0"
                [min]="0"
                [max]="20000"
                (changed)="setMinPixels(f.id, { height: $event })"
              />
            </div>
          }
          @case ('artwork') {
            <p class="ed-hint">Choices: {{ artworkChoices(f) }}</p>
          }
        }

        <h4 class="ed-subtitle">Show this field</h4>
        <app-select
          label="When"
          [options]="ruleOptions"
          [value]="mode()"
          (changed)="setMode(f.id, $event)"
        />
        @switch (mode()) {
          @case ('artwork') {
            <app-select
              label="Artwork selected"
              [options]="artworkOptions()"
              [value]="ruleArtwork()"
              (changed)="setRule(f.id, { op: 'artwork', artworkId: $event })"
            />
          }
          @case ('filled') {
            <app-select
              label="Field has a value"
              [options]="otherFieldOptions(f.id)"
              [value]="ruleField()"
              (changed)="setRule(f.id, { op: 'field-filled', fieldId: $event })"
            />
          }
          @case ('variant') {
            <app-select
              label="Variant is"
              [options]="variantOptions()"
              [value]="ruleVariant()"
              (changed)="setRule(f.id, { op: 'variant', variantIds: [$event] })"
            />
          }
          @case ('advanced') {
            <p class="ed-hint">This field uses an advanced rule (kept as saved).</p>
          }
        }
      </section>
    }
  `,
})
export class FieldEditorComponent {
  protected readonly store = inject(EditorStore);
  protected readonly Math = Math;

  readonly fieldId = input.required<string>();

  protected readonly styleControls: TextStyleControl[] = ['bold', 'italic', 'underline', 'align'];
  protected readonly defaultAccept: AcceptedImageType[] = ['image/png', 'image/jpeg'];
  protected readonly imageTypes: { value: AcceptedImageType; label: string }[] = [
    { value: 'image/png', label: 'PNG' },
    { value: 'image/jpeg', label: 'JPEG' },
  ];
  protected readonly ruleOptions: Option[] = [
    { value: 'always', label: 'Always' },
    { value: 'artwork', label: 'When an artwork is selected' },
    { value: 'filled', label: 'When another field has a value' },
    { value: 'variant', label: 'For one variant' },
    { value: 'advanced', label: 'Advanced rule (keep)' },
  ];

  protected readonly field = computed<FieldSpec | null>(
    () => this.store.config()?.fields.find((f) => f.id === this.fieldId()) ?? null,
  );

  protected text(f: FieldSpec): TextFieldSpec {
    return f as TextFieldSpec;
  }
  protected image(f: FieldSpec): ImageFieldSpec {
    return f as ImageFieldSpec;
  }

  protected patch(patch: Record<string, unknown>, discrete = false): void {
    const id = this.fieldId();
    this.store.edit(
      (c) => edit.updateField(c, id, patch),
      discrete ? undefined : `field:${id}:${Object.keys(patch)[0]}`,
    );
  }

  protected fontOptions(f: FieldSpec): Option[] {
    const fonts = this.store.config()?.fonts ?? [];
    return this.text(f).fontIds.map((id) => ({
      value: id,
      label: fonts.find((x) => x.id === id)?.label ?? id,
    }));
  }

  protected colorOptions(f: FieldSpec): Option[] {
    return this.text(f).colors.map((c) => ({ value: c, label: c }));
  }

  protected setDefault(id: string, patch: Record<string, unknown>): void {
    const f = this.field() as TextFieldSpec | null;
    if (!f) return;
    this.store.edit(
      (c) =>
        edit.updateField(c, id, {
          defaultValue: {
            text: f.defaultValue?.text ?? '',
            fontId: f.defaultValue?.fontId ?? f.fontIds[0],
            color: f.defaultValue?.color ?? f.colors[0],
            ...f.defaultValue,
            ...patch,
          },
        }),
      `field:${id}:default`,
    );
  }

  protected toggleFont(id: string, fontId: string, on: boolean): void {
    const f = this.field() as TextFieldSpec | null;
    if (!f) return;
    const next = on ? [...new Set([...f.fontIds, fontId])] : f.fontIds.filter((x) => x !== fontId);
    if (next.length === 0) return;
    const defaultValue =
      f.defaultValue && !next.includes(f.defaultValue.fontId ?? next[0])
        ? { ...f.defaultValue, fontId: next[0] }
        : f.defaultValue;
    this.patch({ fontIds: next, defaultValue }, true);
  }

  protected addColor(id: string, color: string): void {
    const f = this.field() as TextFieldSpec | null;
    if (!f || f.colors.includes(color) || f.colors.length >= 12) return;
    this.patch({ colors: [...f.colors, color] }, true);
  }

  protected removeColor(id: string, color: string): void {
    const f = this.field() as TextFieldSpec | null;
    if (!f || f.colors.length <= 1) return;
    const colors = f.colors.filter((c) => c !== color);
    const defaultValue =
      f.defaultValue && f.defaultValue.color === color
        ? { ...f.defaultValue, color: colors[0] }
        : f.defaultValue;
    this.patch({ colors, defaultValue }, true);
  }

  protected toggleStyle(id: string, control: TextStyleControl, on: boolean): void {
    const f = this.field() as TextFieldSpec | null;
    if (!f) return;
    const next = on
      ? [...new Set([...(f.styleControls ?? []), control])]
      : (f.styleControls ?? []).filter((x) => x !== control);
    this.patch({ styleControls: next.length > 0 ? next : undefined }, true);
  }

  protected toggleAccept(id: string, type: AcceptedImageType, on: boolean): void {
    const f = this.field() as ImageFieldSpec | null;
    if (!f) return;
    const current = f.accept ?? this.defaultAccept;
    const next = on ? [...new Set([...current, type])] : current.filter((x) => x !== type);
    if (next.length === 0) return;
    this.patch({ accept: next }, true);
  }

  protected setMinPixels(id: string, patch: { width?: number; height?: number }): void {
    const f = this.field() as ImageFieldSpec | null;
    if (!f) return;
    const width = patch.width ?? f.minPixels?.width ?? 0;
    const height = patch.height ?? f.minPixels?.height ?? 0;
    this.patch({ minPixels: width > 0 && height > 0 ? { width, height } : undefined });
  }

  protected artworkChoices(f: FieldSpec): string {
    return f.type === 'artwork' ? f.choices.map((c) => c.label).join(', ') : '';
  }

  // ---- show-when rule ---------------------------------------------------------------------------

  protected readonly rule = computed<Condition | null>(() => this.field()?.showWhen ?? null);

  protected readonly mode = computed<RuleMode>(() => {
    const rule = this.rule();
    if (!rule) return 'always';
    if (rule.op === 'artwork' && !rule.printableAreaId) return 'artwork';
    if (rule.op === 'field-filled') return 'filled';
    if (rule.op === 'variant' && rule.variantIds.length === 1) return 'variant';
    return 'advanced';
  });

  protected readonly ruleArtwork = computed(() => {
    const rule = this.rule();
    return rule?.op === 'artwork' ? rule.artworkId : (this.store.config()?.artworks[0]?.id ?? '');
  });
  protected readonly ruleField = computed(() => {
    const rule = this.rule();
    return rule?.op === 'field-filled' ? rule.fieldId : '';
  });
  protected readonly ruleVariant = computed(() => {
    const rule = this.rule();
    return rule?.op === 'variant'
      ? rule.variantIds[0]
      : (this.store.config()?.variants[0]?.id ?? '');
  });

  protected artworkOptions(): Option[] {
    const c = this.store.config();
    return (c?.artworks ?? []).map((a) => ({
      value: a.id,
      label: `${c?.printableAreas.find((x) => x.id === a.printableAreaId)?.name ?? ''} - ${a.name}`,
    }));
  }

  protected otherFieldOptions(id: string): Option[] {
    return (this.store.config()?.fields ?? [])
      .filter((f) => f.id !== id)
      .map((f) => ({ value: f.id, label: f.label }));
  }

  protected variantOptions(): Option[] {
    return (this.store.config()?.variants ?? []).map((v) => ({ value: v.id, label: v.label }));
  }

  protected setMode(id: string, mode: string): void {
    const c = this.store.config();
    if (!c) return;
    switch (mode) {
      case 'always':
        return this.setRule(id, undefined);
      case 'artwork':
        return this.setRule(id, { op: 'artwork', artworkId: this.ruleArtwork() });
      case 'filled': {
        const other = c.fields.find((f) => f.id !== id);
        return other ? this.setRule(id, { op: 'field-filled', fieldId: other.id }) : undefined;
      }
      case 'variant':
        return this.setRule(id, { op: 'variant', variantIds: [this.ruleVariant()] });
    }
  }

  protected setRule(id: string, rule: Condition | undefined): void {
    this.store.edit((c) => edit.updateField(c, id, { showWhen: rule }));
  }
}
