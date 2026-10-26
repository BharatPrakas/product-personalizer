import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { Component, computed, inject } from '@angular/core';
import type { MessageKey } from '../../admin/i18n/messages.en';
import { ArtworkLayer, TextLayer } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';
import { FieldEditorComponent } from './field-editor.component';
import { ShapeFieldComponent } from './shape-field.component';

const KIND: Record<ArtworkLayer['type'], MessageKey> = {
  'fixed-image': 'layers.kind.fixed-image',
  'image-placeholder': 'inspector.layer.kind.photo',
  text: 'layers.kind.text',
  artwork: 'layers.kind.artwork',
  shape: 'layers.kind.shape',
};

/** Inspector for the selected layer: its customer input (if any), appearance, geometry and advanced options. */
@Component({
  selector: 'app-layer-props',
  imports: [CONTROLS, ShapeFieldComponent, FieldEditorComponent, SectionComponent, TranslatePipe],
  template: `
    @if (layer(); as l) {
      <header class="inspector-head">
        <p class="inspector-kind">{{ kind(l) }}</p>
        <app-text-in
          [label]="'inspector.layer.name' | t"
          [value]="l.name ?? ''"
          [maxlength]="80"
          (changed)="set({ name: $event || undefined }, 'name')"
        />
      </header>

      @switch (l.type) {
        @case ('image-placeholder') {
          <app-field-editor [fieldId]="l.fieldId" />
          <app-section [title]="'inspector.layer.photo-slot' | t">
            <app-select
              [label]="'inspector.layer.default-fit' | t"
              [options]="slotFit()"
              [value]="l.fit ?? 'cover'"
              (changed)="set({ fit: $event })"
            />
            <p class="field-hint">
              {{ 'inspector.layer.slot-hint' | t }}
            </p>
            <app-text-in
              [label]="'inspector.layer.empty-label' | t"
              [value]="l.placeholderLabel ?? ''"
              [maxlength]="60"
              (changed)="set({ placeholderLabel: $event || undefined }, 'ph')"
            />
            <app-shape-field
              [label]="'inspector.layer.mask' | t"
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
            <app-section [title]="'layers.kind.text' | t">
              <app-text-in
                [label]="'inspector.layer.content' | t"
                [multiline]="true"
                [value]="l.text ?? ''"
                (changed)="set({ text: $event }, 'text')"
              />
              <app-select
                [label]="'inspector.layer.font' | t"
                [options]="fontOptions()"
                [value]="l.fontId ?? ''"
                (changed)="set({ fontId: $event })"
              />
              <app-color
                [label]="'inspector.colour' | t"
                [value]="l.color ?? '#111827'"
                (changed)="set({ color: $event }, 'color')"
              />
            </app-section>
          }
          <app-section [title]="'inspector.layer.typography' | t">
            <div class="grid-2">
              <app-num
                [label]="'inspector.layer.font-size' | t"
                [value]="l.fontSize"
                [min]="1"
                (changed)="setSize(l, { fontSize: $event })"
              />
              <app-num
                [label]="'inspector.layer.min-size' | t"
                [value]="l.minFontSize"
                [min]="1"
                (changed)="setSize(l, { minFontSize: $event })"
              />
              <app-select
                [label]="'inspector.layer.align' | t"
                [options]="alignOptions()"
                [value]="l.align"
                (changed)="set({ align: $event })"
              />
              <app-select
                [label]="'inspector.layer.vertical' | t"
                [options]="verticalOptions()"
                [value]="l.verticalAlign ?? 'middle'"
                (changed)="set({ verticalAlign: $event === 'middle' ? undefined : $event })"
              />
              <app-num
                [label]="'inspector.layer.line-height' | t"
                [value]="l.lineHeight ?? 1.2"
                [min]="0.5"
                [max]="4"
                step="0.05"
                (changed)="set({ lineHeight: $event }, 'lh')"
              />
            </div>
            <div class="row">
              <app-check
                [label]="'inspector.layer.bold' | t"
                [value]="l.bold === true"
                (changed)="set({ bold: $event || undefined })"
              />
              <app-check
                [label]="'inspector.layer.italic' | t"
                [value]="l.italic === true"
                (changed)="set({ italic: $event || undefined })"
              />
              <app-check
                [label]="'inspector.layer.underline' | t"
                [value]="l.underline === true"
                (changed)="set({ underline: $event || undefined })"
              />
            </div>
            <app-check
              [label]="'inspector.layer.wrap' | t"
              [value]="l.wrap === true"
              (changed)="set({ wrap: $event || undefined })"
            />
            <p class="field-hint">
              {{ 'inspector.layer.text-hint' | t }}
            </p>
          </app-section>
        }
        @case ('artwork') {
          <app-field-editor [fieldId]="l.fieldId" />
        }
        @case ('fixed-image') {
          <app-section [title]="'inspector.layer.image' | t">
            <app-select
              [label]="'inspector.layer.fit' | t"
              [options]="fixedFit()"
              [value]="l.fit ?? 'contain'"
              (changed)="set({ fit: $event })"
            />
            <app-file
              [label]="'inspector.layer.replace-image' | t"
              (chosen)="replaceImage($event)"
            />
            <app-shape-field
              [label]="'inspector.layer.mask' | t"
              [allowNone]="true"
              [shape]="l.clip ?? null"
              (changed)="set({ clip: $event ?? undefined })"
            />
          </app-section>
        }
        @case ('shape') {
          <app-section [title]="'layers.kind.shape' | t">
            <app-shape-field [shape]="l.shape" (changed)="set({ shape: $event ?? l.shape })" />
            <app-color
              [label]="'inspector.layer.fill' | t"
              [allowTransparent]="true"
              [value]="l.fill"
              (changed)="set({ fill: $event }, 'fill')"
            />
            <app-color
              [label]="'inspector.layer.outline' | t"
              [allowTransparent]="true"
              [value]="l.stroke ?? 'transparent'"
              (changed)="set({ stroke: $event === 'transparent' ? undefined : $event }, 'stroke')"
            />
            <app-num
              [label]="'inspector.layer.outline-width' | t"
              [value]="l.strokeWidth ?? 0"
              [min]="0"
              [max]="1000"
              (changed)="set({ strokeWidth: $event || undefined }, 'sw')"
            />
          </app-section>
        }
      }

      <app-section [title]="'inspector.layer.position' | t">
        <div class="grid-2">
          <app-num
            [label]="'inspector.placement.x' | t"
            [value]="l.x"
            (changed)="set({ x: $event }, 'x')"
          />
          <app-num
            [label]="'inspector.placement.y' | t"
            [value]="l.y"
            (changed)="set({ y: $event }, 'y')"
          />
          <app-num
            [label]="'inspector.width' | t"
            [value]="l.width"
            [min]="1"
            (changed)="set({ width: $event }, 'w')"
          />
          <app-num
            [label]="'inspector.height' | t"
            [value]="l.height"
            [min]="1"
            (changed)="set({ height: $event }, 'h')"
          />
          <app-num
            [label]="'inspector.placement.rotation' | t"
            [value]="l.rotation ?? 0"
            [min]="-360"
            [max]="360"
            step="0.5"
            (changed)="set({ rotation: $event || undefined }, 'rot')"
          />
          <app-num
            [label]="'inspector.opacity' | t"
            [value]="round((l.opacity ?? 1) * 100)"
            [min]="0"
            [max]="100"
            (changed)="set({ opacity: $event >= 100 ? undefined : $event / 100 }, 'opacity')"
          />
        </div>
        <p class="field-hint">{{ 'inspector.layer.position-hint' | t }}</p>
      </app-section>

      <app-section [title]="'inspector.layer.advanced' | t" [open]="false">
        <div class="row">
          <app-check
            [label]="'inspector.layer.visible' | t"
            [value]="l.visible !== false"
            (changed)="set({ visible: $event ? undefined : false })"
          />
          <app-check
            [label]="'inspector.layer.locked' | t"
            [value]="l.locked === true"
            (changed)="set({ locked: $event ? true : undefined })"
          />
        </div>
        @if (hasField(l)) {
          <app-select
            [label]="'inspector.layer.uses-input' | t"
            [options]="fieldChoices(l)"
            [value]="fieldIdOf(l)"
            (changed)="bind($event)"
          />
          <p class="field-hint">
            {{ 'inspector.layer.share-hint' | t }}
          </p>
        }
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm" (click)="duplicate(l)">
          {{ 'common.duplicate' | t }}
        </button>
        <button type="button" class="btn btn--sm btn--danger" (click)="remove(l)">
          {{ 'common.delete-ellipsis' | t }}
        </button>
      </div>
    }
  `,
})
export class LayerPropsComponent {
  private readonly i18n = inject(I18n);
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);
  protected readonly layer = this.store.layer;

  protected readonly fixedFit = this.options([
    ['contain', 'inspector.opt.contain'],
    ['cover', 'inspector.opt.cover-crop'],
    ['stretch', 'inspector.opt.stretch'],
  ]);
  protected readonly slotFit = this.options([
    ['cover', 'inspector.opt.fill-slot'],
    ['contain', 'inspector.opt.whole-photo'],
  ]);
  protected readonly alignOptions = this.options([
    ['left', 'inspector.opt.left'],
    ['center', 'inspector.opt.centre'],
    ['right', 'inspector.opt.right'],
  ]);
  protected readonly verticalOptions = this.options([
    ['top', 'inspector.opt.top'],
    ['middle', 'inspector.opt.middle'],
    ['bottom', 'inspector.opt.bottom'],
  ]);

  protected readonly fontOptions = computed<Option[]>(() =>
    (this.store.config()?.fonts ?? []).map((f) => ({ value: f.id, label: f.label ?? f.family })),
  );

  private options(items: readonly (readonly [string, MessageKey])[]) {
    return computed<Option[]>(() =>
      items.map(([value, label]) => ({ value, label: this.i18n.t(label) })),
    );
  }

  protected round(n: number): number {
    return Math.round(n);
  }

  protected kind(l: ArtworkLayer): string {
    return this.i18n.t(
      l.type === 'text' && !l.fieldId
        ? 'layers.fixed-text'
        : l.type === 'text'
          ? 'inspector.layer.kind.text-input'
          : KIND[l.type],
    );
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
      title: this.i18n.t('layers.delete.title', { name: l.name || this.i18n.t(KIND[l.type]) }),
      message: this.i18n.t(
        this.hasField(l) ? 'layers.delete.message-input' : 'layers.delete.message',
      ),
      confirmLabel: this.i18n.t('layers.delete.confirm'),
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeLayer(c, l.id));
    this.store.select({ kind: 'artwork', id: this.store.artwork()?.id ?? '' });
  }
}
