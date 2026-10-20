import { Component, computed, inject } from '@angular/core';
import { ArtworkLayer, TextLayer } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';
import { FieldEditorComponent } from './field-editor.component';
import { ShapeFieldComponent } from './shape-field.component';

const KIND: Record<ArtworkLayer['type'], string> = {
  'fixed-image': 'Fixed image',
  'image-placeholder': 'Customer photo upload',
  text: 'Text',
  artwork: 'Clipart choice',
  shape: 'Shape',
};

/** Inspector for the selected layer: its customer input (if any), appearance, geometry and advanced options. */
@Component({
  selector: 'app-layer-props',
  imports: [CONTROLS, ShapeFieldComponent, FieldEditorComponent, SectionComponent],
  template: `
    @if (layer(); as l) {
      <header class="inspector-head">
        <p class="inspector-kind">{{ kind(l) }}</p>
        <app-text-in
          label="Layer name"
          [value]="l.name ?? ''"
          [maxlength]="80"
          (changed)="set({ name: $event || undefined }, 'name')"
        />
      </header>

      @switch (l.type) {
        @case ('image-placeholder') {
          <app-field-editor [fieldId]="l.fieldId" />
          <app-section title="Photo slot">
            <app-select
              label="Default fit"
              [options]="slotFit"
              [value]="l.fit ?? 'cover'"
              (changed)="set({ fit: $event })"
            />
            <p class="field-hint">
              Customers can zoom, move, rotate and change the fit of their photo inside the slot.
            </p>
            <app-text-in
              label="Label shown in the empty slot"
              [value]="l.placeholderLabel ?? ''"
              [maxlength]="60"
              (changed)="set({ placeholderLabel: $event || undefined }, 'ph')"
            />
            <app-shape-field
              label="Mask"
              [allowNone]="true"
              [shape]="l.clip ?? null"
              (changed)="set({ clip: $event ?? undefined })"
            />
          </app-section>
        }
        @case ('text') {
          @if (l.fieldId) {
            <app-field-editor [fieldId]="l.fieldId" />
          } @else {
            <app-section title="Text">
              <app-text-in
                label="Content"
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
            </app-section>
          }
          <app-section title="Typography">
            <div class="grid-2">
              <app-num
                label="Font size (px)"
                [value]="l.fontSize"
                [min]="1"
                (changed)="setSize(l, { fontSize: $event })"
              />
              <app-num
                label="Smallest size (auto-fit)"
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
            <div class="row">
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
            </div>
            <app-check
              label="Wrap onto several lines"
              [value]="l.wrap === true"
              (changed)="set({ wrap: $event || undefined })"
            />
            <p class="field-hint">
              Text shrinks to the smallest size to fit; if it still does not fit, customers see a
              message.
            </p>
          </app-section>
        }
        @case ('artwork') {
          <app-field-editor [fieldId]="l.fieldId" />
        }
        @case ('fixed-image') {
          <app-section title="Image">
            <app-select
              label="Fit"
              [options]="fixedFit"
              [value]="l.fit ?? 'contain'"
              (changed)="set({ fit: $event })"
            />
            <app-file label="Replace image" (chosen)="replaceImage($event)" />
            <app-shape-field
              label="Mask"
              [allowNone]="true"
              [shape]="l.clip ?? null"
              (changed)="set({ clip: $event ?? undefined })"
            />
          </app-section>
        }
        @case ('shape') {
          <app-section title="Shape">
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
              label="Outline width (px)"
              [value]="l.strokeWidth ?? 0"
              [min]="0"
              [max]="1000"
              (changed)="set({ strokeWidth: $event || undefined }, 'sw')"
            />
          </app-section>
        }
      }

      <app-section title="Position and size">
        <div class="grid-2">
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
        <p class="field-hint">Pixels of this printable area's production canvas.</p>
      </app-section>

      <app-section title="Advanced" [open]="false">
        <div class="row">
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
        @if (hasField(l)) {
          <app-select
            label="Customer input this layer uses"
            [options]="fieldChoices(l)"
            [value]="fieldIdOf(l)"
            (changed)="bind($event)"
          />
          <p class="field-hint">
            Choose another input to share it, so several layers show what the customer enters once.
          </p>
        }
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm" (click)="duplicate(l)">Duplicate</button>
        <button type="button" class="btn btn--sm btn--danger" (click)="remove(l)">Delete…</button>
      </div>
    }
  `,
})
export class LayerPropsComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);
  protected readonly layer = this.store.layer;

  protected readonly fixedFit: Option[] = [
    { value: 'contain', label: 'Contain' },
    { value: 'cover', label: 'Cover (crop)' },
    { value: 'stretch', label: 'Stretch' },
  ];
  protected readonly slotFit: Option[] = [
    { value: 'cover', label: 'Fill the slot (crop)' },
    { value: 'contain', label: 'Show the whole photo' },
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

  protected kind(l: ArtworkLayer): string {
    return l.type === 'text' && !l.fieldId
      ? 'Fixed text'
      : l.type === 'text'
        ? 'Customer text input'
        : KIND[l.type];
  }

  protected set(patch: Record<string, unknown>, key?: string): void {
    const l = this.layer();
    if (!l) return;
    this.store.edit(
      (c) => edit.updateLayer(c, l.id, patch),
      key ? `layer:${l.id}:${key}` : undefined,
    );
  }

  /** Keep the smallest size at or below the font size so the configuration stays valid while typing. */
  protected setSize(l: TextLayer, patch: { fontSize?: number; minFontSize?: number }): void {
    const fontSize = patch.fontSize ?? l.fontSize;
    const minFontSize = Math.min(patch.minFontSize ?? l.minFontSize, fontSize);
    this.set({ fontSize, minFontSize }, 'size');
  }

  protected hasField(l: ArtworkLayer): boolean {
    return (
      l.type === 'image-placeholder' || l.type === 'artwork' || (l.type === 'text' && !!l.fieldId)
    );
  }

  protected fieldIdOf(l: ArtworkLayer): string {
    return 'fieldId' in l && l.fieldId ? l.fieldId : '';
  }

  /** Other inputs of the same kind, named by what customers see (a number tells equal labels apart). */
  protected fieldChoices(l: ArtworkLayer): Option[] {
    const type =
      l.type === 'image-placeholder' ? 'image' : l.type === 'artwork' ? 'artwork' : 'text';
    const fields = (this.store.config()?.fields ?? []).filter((f) => f.type === type);
    const seen = new Map<string, number>();
    return fields.map((f) => {
      const n = (seen.get(f.label) ?? 0) + 1;
      seen.set(f.label, n);
      const duplicated = fields.filter((x) => x.label === f.label).length > 1;
      return { value: f.id, label: duplicated ? `${f.label} (${n})` : f.label };
    });
  }

  protected bind(fieldId: string): void {
    const l = this.layer();
    if (l) this.store.edit((c) => edit.bindLayerToField(c, l.id, fieldId));
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

  protected async remove(l: ArtworkLayer): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: `Delete “${l.name || KIND[l.type]}”?`,
      message: this.hasField(l)
        ? 'The customer input it feeds is removed too, unless another layer uses it. You can undo this.'
        : 'You can undo this.',
      confirmLabel: 'Delete layer',
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeLayer(c, l.id));
    this.store.select({ kind: 'artwork', id: this.store.artwork()?.id ?? '' });
  }
}
