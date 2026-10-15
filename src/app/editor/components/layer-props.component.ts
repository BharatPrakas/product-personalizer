import { Component, computed, inject } from '@angular/core';
import { ArtworkLayer, TextLayer } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';
import { FieldEditorComponent } from './field-editor.component';
import { ShapeFieldComponent } from './shape-field.component';

/** Properties of the selected layer: geometry, appearance, type-specific settings and its customer field. */
@Component({
  selector: 'app-layer-props',
  imports: [CONTROLS, ShapeFieldComponent, FieldEditorComponent],
  template: `
    @if (layer(); as l) {
      <section class="ed-group">
        <h3 class="ed-title">Layer: {{ l.name || l.type }}</h3>
        <app-text-in
          label="Name"
          [value]="l.name ?? ''"
          [maxlength]="80"
          (changed)="set({ name: $event || undefined }, 'name')"
        />
        <p class="ed-hint">Type: {{ typeLabel(l) }}</p>
        <div class="ed-grid">
          <app-num label="X" [value]="l.x" (changed)="set({ x: $event }, 'x')" />
          <app-num label="Y" [value]="l.y" (changed)="set({ y: $event }, 'y')" />
          <app-num
            label="Width"
            [value]="l.width"
            [min]="1"
            (changed)="set({ width: $event }, 'w')"
          />
          <app-num
            label="Height"
            [value]="l.height"
            [min]="1"
            (changed)="set({ height: $event }, 'h')"
          />
          <app-num
            label="Rotation (°)"
            [value]="l.rotation ?? 0"
            [min]="-360"
            [max]="360"
            step="0.5"
            (changed)="set({ rotation: $event || undefined }, 'rot')"
          />
          <app-num
            label="Opacity (%)"
            [value]="round((l.opacity ?? 1) * 100)"
            [min]="0"
            [max]="100"
            (changed)="set({ opacity: $event >= 100 ? undefined : $event / 100 }, 'opacity')"
          />
        </div>
        <div class="ed-row">
          <app-check
            label="Visible"
            [value]="l.visible !== false"
            (changed)="set({ visible: $event ? undefined : false })"
          />
          <app-check
            label="Locked"
            [value]="l.locked === true"
            (changed)="set({ locked: $event ? true : undefined })"
          />
        </div>
        @if (l.type !== 'shape') {
          <app-shape-field
            label="Clipping mask"
            [allowNone]="true"
            [shape]="l.clip ?? null"
            (changed)="set({ clip: $event ?? undefined })"
          />
        }
      </section>

      @switch (l.type) {
        @case ('fixed-image') {
          <section class="ed-group">
            <h4 class="ed-subtitle">Fixed image</h4>
            <app-select
              label="Fit"
              [options]="fixedFit"
              [value]="l.fit ?? 'contain'"
              (changed)="set({ fit: $event })"
            />
            <app-file label="Replace image" (chosen)="replaceImage($event)" />
          </section>
        }
        @case ('image-placeholder') {
          <section class="ed-group">
            <h4 class="ed-subtitle">Customer photo slot</h4>
            <app-select
              label="Default fit"
              [options]="slotFit"
              [value]="l.fit ?? 'cover'"
              (changed)="set({ fit: $event })"
            />
            <app-text-in
              label="Empty-slot label"
              [value]="l.placeholderLabel ?? ''"
              [maxlength]="60"
              (changed)="set({ placeholderLabel: $event || undefined }, 'ph')"
            />
            <app-select
              label="Bound to field"
              [options]="fieldOptions('image')"
              [value]="l.fieldId"
              (changed)="bind($event)"
            />
          </section>
          <app-field-editor [fieldId]="l.fieldId" />
        }
        @case ('text') {
          <section class="ed-group">
            <h4 class="ed-subtitle">{{ l.fieldId ? 'Customer text' : 'Fixed text' }}</h4>
            @if (!l.fieldId) {
              <app-text-in
                label="Text"
                [multiline]="true"
                [value]="l.text ?? ''"
                (changed)="set({ text: $event }, 'text')"
              />
              <app-select
                label="Font"
                [options]="fontOptions()"
                [value]="l.fontId ?? ''"
                (changed)="set({ fontId: $event })"
              />
              <app-color
                label="Colour"
                [value]="l.color ?? '#111827'"
                (changed)="set({ color: $event }, 'color')"
              />
            } @else {
              <app-select
                label="Bound to field"
                [options]="fieldOptions('text')"
                [value]="l.fieldId"
                (changed)="bind($event)"
              />
              <p class="ed-hint">
                Font and colour come from the customer's choices (see the field below).
              </p>
            }
            <div class="ed-grid">
              <app-num
                label="Font size"
                [value]="l.fontSize"
                [min]="1"
                (changed)="setSize(l, { fontSize: $event })"
              />
              <app-num
                label="Min. size (auto-fit)"
                [value]="l.minFontSize"
                [min]="1"
                (changed)="setSize(l, { minFontSize: $event })"
              />
              <app-select
                label="Align"
                [options]="alignOptions"
                [value]="l.align"
                (changed)="set({ align: $event })"
              />
              <app-select
                label="Vertical"
                [options]="verticalOptions"
                [value]="l.verticalAlign ?? 'middle'"
                (changed)="set({ verticalAlign: $event === 'middle' ? undefined : $event })"
              />
              <app-num
                label="Line height"
                [value]="l.lineHeight ?? 1.2"
                [min]="0.5"
                [max]="4"
                step="0.05"
                (changed)="set({ lineHeight: $event }, 'lh')"
              />
            </div>
            <div class="ed-row">
              <app-check
                label="Bold"
                [value]="l.bold === true"
                (changed)="set({ bold: $event || undefined })"
              />
              <app-check
                label="Italic"
                [value]="l.italic === true"
                (changed)="set({ italic: $event || undefined })"
              />
              <app-check
                label="Underline"
                [value]="l.underline === true"
                (changed)="set({ underline: $event || undefined })"
              />
              <app-check
                label="Wrap lines"
                [value]="l.wrap === true"
                (changed)="set({ wrap: $event || undefined })"
              />
            </div>
          </section>
          @if (l.fieldId) {
            <app-field-editor [fieldId]="l.fieldId" />
          }
        }
        @case ('artwork') {
          <section class="ed-group">
            <h4 class="ed-subtitle">Clipart choice</h4>
            <app-select
              label="Bound to field"
              [options]="fieldOptions('artwork')"
              [value]="l.fieldId"
              (changed)="bind($event)"
            />
          </section>
          <app-field-editor [fieldId]="l.fieldId" />
        }
        @case ('shape') {
          <section class="ed-group">
            <h4 class="ed-subtitle">Shape</h4>
            <app-shape-field [shape]="l.shape" (changed)="set({ shape: $event ?? l.shape })" />
            <app-color
              label="Fill"
              [allowTransparent]="true"
              [value]="l.fill"
              (changed)="set({ fill: $event }, 'fill')"
            />
            <app-color
              label="Outline"
              [allowTransparent]="true"
              [value]="l.stroke ?? 'transparent'"
              (changed)="set({ stroke: $event === 'transparent' ? undefined : $event }, 'stroke')"
            />
            <app-num
              label="Outline width"
              [value]="l.strokeWidth ?? 0"
              [min]="0"
              [max]="1000"
              (changed)="set({ strokeWidth: $event || undefined }, 'sw')"
            />
          </section>
        }
      }

      <div class="ed-row ed-actions">
        <button type="button" class="ed-btn" (click)="duplicate(l)">Duplicate</button>
        <button type="button" class="ed-btn ed-btn-danger" (click)="remove(l)">Delete</button>
      </div>
    }
  `,
})
export class LayerPropsComponent {
  protected readonly store = inject(EditorStore);
  protected readonly layer = this.store.layer;

  protected readonly fixedFit: Option[] = [
    { value: 'contain', label: 'Contain' },
    { value: 'cover', label: 'Cover (crop)' },
    { value: 'stretch', label: 'Stretch' },
  ];
  protected readonly slotFit: Option[] = [
    { value: 'cover', label: 'Cover (crop to fill)' },
    { value: 'contain', label: 'Contain (whole photo)' },
  ];
  protected readonly alignOptions: Option[] = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Centre' },
    { value: 'right', label: 'Right' },
  ];
  protected readonly verticalOptions: Option[] = [
    { value: 'top', label: 'Top' },
    { value: 'middle', label: 'Middle' },
    { value: 'bottom', label: 'Bottom' },
  ];

  protected readonly fontOptions = computed<Option[]>(() =>
    (this.store.config()?.fonts ?? []).map((f) => ({ value: f.id, label: f.label ?? f.family })),
  );

  protected round(n: number): number {
    return Math.round(n);
  }

  protected typeLabel(l: ArtworkLayer): string {
    switch (l.type) {
      case 'fixed-image':
        return 'Fixed image';
      case 'image-placeholder':
        return 'Customer image placeholder';
      case 'text':
        return l.fieldId ? 'Editable customer text' : 'Fixed text';
      case 'artwork':
        return 'Predefined artwork / clipart';
      case 'shape':
        return 'Vector shape';
    }
  }

  protected set(patch: Record<string, unknown>, key?: string): void {
    const l = this.layer();
    if (!l) return;
    this.store.edit(
      (c) => edit.updateLayer(c, l.id, patch),
      key ? `layer:${l.id}:${key}` : undefined,
    );
  }

  /** Keep minFontSize <= fontSize so the configuration stays valid while typing. */
  protected setSize(l: TextLayer, patch: { fontSize?: number; minFontSize?: number }): void {
    const fontSize = patch.fontSize ?? l.fontSize;
    const minFontSize = Math.min(patch.minFontSize ?? l.minFontSize, fontSize);
    this.set({ fontSize, minFontSize }, 'size');
  }

  protected fieldOptions(type: 'image' | 'text' | 'artwork'): Option[] {
    return (this.store.config()?.fields ?? [])
      .filter((f) => f.type === type)
      .map((f) => ({ value: f.id, label: `${f.label} (${f.id})` }));
  }

  protected bind(fieldId: string): void {
    const l = this.layer();
    if (!l) return;
    this.store.edit((c) => edit.bindLayerToField(c, l.id, fieldId));
  }

  protected async replaceImage(file: File): Promise<void> {
    const l = this.layer();
    const src = await this.store.uploadImage(file);
    if (l && src) this.store.edit((c) => edit.updateLayer(c, l.id, { src }));
  }

  protected duplicate(l: ArtworkLayer): void {
    let created = '';
    this.store.edit((c) => {
      const r = edit.duplicateLayer(c, l.id);
      created = r?.layerId ?? '';
      return r?.config ?? c;
    });
    if (created) this.store.select({ kind: 'layer', id: created });
  }

  protected remove(l: ArtworkLayer): void {
    this.store.edit((c) => edit.removeLayer(c, l.id));
    this.store.select({ kind: 'artwork', id: this.store.artwork()?.id ?? '' });
  }
}
