import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ArtworkLayer } from '../../customizer/models/product.models';
import type { MessageKey } from '../../admin/i18n/messages.en';
import { ConfirmService } from '../../ui/confirm.service';
import { IconComponent, IconName } from '../../ui/icon.component';
import { MenuComponent } from '../../ui/menu.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';

const ICONS: Record<ArtworkLayer['type'], IconName> = {
  'fixed-image': 'image',
  'image-placeholder': 'upload',
  text: 'text',
  artwork: 'shapes',
  shape: 'square',
};

const KIND_LABEL: Record<ArtworkLayer['type'], MessageKey> = {
  'fixed-image': 'layers.kind.fixed-image',
  'image-placeholder': 'layers.kind.image-placeholder',
  text: 'layers.kind.text',
  artwork: 'layers.kind.artwork',
  shape: 'layers.kind.shape',
};

/** Sidebar tab: the layers of the open artwork, front first. Drag rows (or use the menu) to reorder. */
@Component({
  selector: 'app-layers-tab',
  imports: [IconComponent, MenuComponent, TranslatePipe],
  template: `
    @let art = store.artwork();
    <div class="tab-head">
      <h2 class="tab-title">{{ 'layers.title' | t }}</h2>
      <app-menu
        [label]="'layers.add-label' | t"
        [text]="'layers.add' | t"
        variant="primary"
        align="end"
        [disabled]="!art"
      >
        <div class="menu-label">{{ 'layers.menu.inputs' | t }}</div>
        <button type="button" class="menu-item" role="menuitem" (click)="add('image-placeholder')">
          <app-icon name="upload" [size]="16" />
          <span
            >{{ 'layers.photo-upload' | t
            }}<small>{{ 'layers.photo-upload-hint' | t }}</small></span
          >
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('text-editable')">
          <app-icon name="text" [size]="16" />
          <span
            >{{ 'layers.editable-text' | t
            }}<small>{{ 'layers.editable-text-hint' | t }}</small></span
          >
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('artwork-choice')">
          <app-icon name="shapes" [size]="16" />
          <span
            >{{ 'layers.clipart' | t }}<small>{{ 'layers.clipart-hint' | t }}</small></span
          >
        </button>
        <div class="menu-sep"></div>
        <div class="menu-label">{{ 'layers.menu.fixed' | t }}</div>
        <button type="button" class="menu-item" role="menuitem" (click)="chooseFixedImage()">
          <app-icon name="image" [size]="16" /> {{ 'layers.fixed-image-menu' | t }}
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('text-fixed')">
          <app-icon name="text" [size]="16" /> {{ 'layers.fixed-text' | t }}
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('shape-rect')">
          <app-icon name="square" [size]="16" /> {{ 'layers.rect' | t }}
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('shape-ellipse')">
          <app-icon name="circle" [size]="16" /> {{ 'layers.ellipse' | t }}
        </button>
      </app-menu>
      <input
        #fixedImageInput
        class="sr-only"
        type="file"
        tabindex="-1"
        aria-hidden="true"
        accept="image/png,image/jpeg,image/webp"
        (change)="onFixedImage($event)"
      />
    </div>

    @if (!art) {
      <p class="tab-empty">
        {{ 'layers.empty-select' | t }}
      </p>
    } @else {
      <p class="list-context truncate"><app-icon name="artwork" [size]="14" /> {{ art.name }}</p>
      @if (art.layers.length === 0) {
        <p class="tab-empty">
          {{ 'layers.empty' | t }}
        </p>
      }
      <ul
        class="list"
        [attr.aria-label]="'layers.list-aria' | t"
        (dragover)="$event.preventDefault()"
      >
        @for (l of reversed(art.layers); track l.id; let i = $index) {
          <li
            class="list-row"
            [class.is-selected]="isSelected(l.id)"
            [class.is-dragging]="dragId() === l.id"
            [class.is-drop-target]="dropIndex() === i && dragId() !== l.id"
            draggable="true"
            (dragstart)="onDragStart($event, l.id)"
            (dragover)="onDragOver($event, i)"
            (drop)="onDrop($event, art.layers.length - 1 - i)"
            (dragend)="onDragEnd()"
          >
            <span class="list-row__grip" aria-hidden="true"
              ><app-icon name="grip" [size]="16"
            /></span>
            <button
              type="button"
              class="list-row__main"
              (click)="store.select({ kind: 'layer', id: l.id })"
            >
              <span class="list-row__icon"><app-icon [name]="icon(l)" [size]="16" /></span>
              <span class="list-row__text">
                <span class="list-row__title truncate" [class.is-muted]="l.visible === false">{{
                  l.name || label(l)
                }}</span>
                <span class="list-row__meta truncate">{{ kind(l) }}</span>
              </span>
            </button>
            <div class="list-row__actions list-row__actions--inline">
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                [attr.aria-label]="
                  (l.visible === false ? 'layers.show-aria' : 'layers.hide-aria')
                    | t: { name: l.name || label(l) }
                "
                [attr.aria-pressed]="l.visible !== false"
                (click)="toggle(l, 'visible')"
              >
                <app-icon [name]="l.visible === false ? 'eye-off' : 'eye'" [size]="16" />
              </button>
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                [attr.aria-label]="
                  (l.locked ? 'layers.unlock-aria' : 'layers.lock-aria')
                    | t: { name: l.name || label(l) }
                "
                [attr.aria-pressed]="l.locked === true"
                (click)="toggle(l, 'locked')"
              >
                <app-icon [name]="l.locked ? 'lock' : 'unlock'" [size]="16" />
              </button>
              <app-menu
                [label]="'list.more-actions' | t: { name: l.name || label(l) }"
                icon="more"
                variant="ghost"
                align="end"
              >
                <button type="button" class="menu-item" role="menuitem" (click)="duplicate(l)">
                  <app-icon name="copy" [size]="16" /> {{ 'common.duplicate' | t }}
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  (click)="move(l, 'forward')"
                >
                  <app-icon name="arrow-up" [size]="16" /> {{ 'layers.forward' | t }}
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  (click)="move(l, 'backward')"
                >
                  <app-icon name="arrow-down" [size]="16" /> {{ 'layers.backward' | t }}
                </button>
                <div class="menu-sep"></div>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(l)"
                >
                  <app-icon name="trash" [size]="16" /> {{ 'common.delete-ellipsis' | t }}
                </button>
              </app-menu>
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class LayersTabComponent {
  private readonly i18n = inject(I18n);
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);
  private readonly fixedImageInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fixedImageInput');

  protected readonly dragId = signal<string | null>(null);
  protected readonly dropIndex = signal<number | null>(null);

  protected reversed(layers: readonly ArtworkLayer[]): ArtworkLayer[] {
    return [...layers].reverse();
  }

  protected icon(l: ArtworkLayer): IconName {
    return ICONS[l.type];
  }

  protected label(l: ArtworkLayer): string {
    return this.i18n.t(KIND_LABEL[l.type]);
  }

  protected kind(l: ArtworkLayer): string {
    return l.type === 'text' && !l.fieldId
      ? this.i18n.t('layers.fixed-text')
      : this.i18n.t(KIND_LABEL[l.type]);
  }

  protected isSelected(id: string): boolean {
    const s = this.store.selection();
    return s.kind === 'layer' && s.id === id;
  }

  protected add(kind: edit.NewLayerKind, src?: string): void {
    const artworkId = this.store.artwork()?.id;
    if (!artworkId) return;
    let created = '';
    this.store.edit((c) => {
      const r = edit.addLayer(c, artworkId, kind, { src });
      created = r?.layerId ?? '';
      return r?.config ?? c;
    });
    if (created) this.store.select({ kind: 'layer', id: created });
  }

  protected chooseFixedImage(): void {
    this.fixedImageInput().nativeElement.click();
  }

  protected async onFixedImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const src = await this.store.uploadImage(file);
    if (src) this.add('fixed-image', src);
  }

  protected toggle(l: ArtworkLayer, what: 'visible' | 'locked'): void {
    const patch =
      what === 'visible'
        ? { visible: l.visible === false ? undefined : false }
        : { locked: l.locked ? undefined : true };
    this.store.edit((c) => edit.updateLayer(c, l.id, patch));
  }

  protected move(l: ArtworkLayer, to: 'forward' | 'backward'): void {
    this.store.edit((c) => edit.moveLayer(c, l.id, to));
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
    const customerInput =
      l.type === 'image-placeholder' || l.type === 'artwork' || (l.type === 'text' && !!l.fieldId);
    const ok = await this.confirmService.confirm({
      title: this.i18n.t('layers.delete.title', { name: l.name || this.label(l) }),
      message: this.i18n.t(customerInput ? 'layers.delete.message-input' : 'layers.delete.message'),
      confirmLabel: this.i18n.t('layers.delete.confirm'),
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeLayer(c, l.id));
    this.store.select({ kind: 'artwork', id: this.store.artwork()?.id ?? '' });
  }

  // ---- drag and drop ordering ------------------------------------------------------------------

  protected onDragStart(event: DragEvent, id: string): void {
    this.dragId.set(id);
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, displayIndex: number): void {
    if (!this.dragId()) return;
    event.preventDefault();
    this.dropIndex.set(displayIndex);
  }

  protected onDrop(event: DragEvent, layerIndex: number): void {
    event.preventDefault();
    const id = this.dragId();
    this.onDragEnd();
    if (id) this.store.edit((c) => edit.reorderLayer(c, id, layerIndex));
  }

  protected onDragEnd(): void {
    this.dragId.set(null);
    this.dropIndex.set(null);
  }
}
