import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ArtworkLayer } from '../../customizer/models/product.models';
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

const KIND_LABEL: Record<ArtworkLayer['type'], string> = {
  'fixed-image': 'Fixed image',
  'image-placeholder': 'Customer photo',
  text: 'Text',
  artwork: 'Clipart choice',
  shape: 'Shape',
};

/** Sidebar tab: the layers of the open artwork, front first. Drag rows (or use the menu) to reorder. */
@Component({
  selector: 'app-layers-tab',
  imports: [IconComponent, MenuComponent],
  template: `
    @let art = store.artwork();
    <div class="tab-head">
      <h2 class="tab-title">Layers</h2>
      <app-menu
        label="Add a layer"
        text="Add layer"
        variant="primary"
        align="end"
        [disabled]="!art"
      >
        <div class="menu-label">Customer inputs</div>
        <button type="button" class="menu-item" role="menuitem" (click)="add('image-placeholder')">
          <app-icon name="upload" [size]="16" />
          <span>Photo upload<small>Customers add their own photo</small></span>
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('text-editable')">
          <app-icon name="text" [size]="16" />
          <span>Editable text<small>Customers type the text</small></span>
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('artwork-choice')">
          <app-icon name="shapes" [size]="16" />
          <span>Clipart choice<small>Customers pick from artwork</small></span>
        </button>
        <div class="menu-sep"></div>
        <div class="menu-label">Fixed design</div>
        <button type="button" class="menu-item" role="menuitem" (click)="chooseFixedImage()">
          <app-icon name="image" [size]="16" /> Fixed image…
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('text-fixed')">
          <app-icon name="text" [size]="16" /> Fixed text
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('shape-rect')">
          <app-icon name="square" [size]="16" /> Rectangle
        </button>
        <button type="button" class="menu-item" role="menuitem" (click)="add('shape-ellipse')">
          <app-icon name="circle" [size]="16" /> Ellipse
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
        Select an artwork in the Artworks tab, or a printable area on the product photo, to see its
        layers.
      </p>
    } @else {
      <p class="list-context truncate"><app-icon name="artwork" [size]="14" /> {{ art.name }}</p>
      @if (art.layers.length === 0) {
        <p class="tab-empty">
          This artwork is empty. Add a photo upload or editable text so customers can personalize
          it.
        </p>
      }
      <ul class="list" aria-label="Layers, front first" (dragover)="$event.preventDefault()">
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
                [attr.aria-label]="(l.visible === false ? 'Show ' : 'Hide ') + (l.name || label(l))"
                [attr.aria-pressed]="l.visible !== false"
                (click)="toggle(l, 'visible')"
              >
                <app-icon [name]="l.visible === false ? 'eye-off' : 'eye'" [size]="16" />
              </button>
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                [attr.aria-label]="(l.locked ? 'Unlock ' : 'Lock ') + (l.name || label(l))"
                [attr.aria-pressed]="l.locked === true"
                (click)="toggle(l, 'locked')"
              >
                <app-icon [name]="l.locked ? 'lock' : 'unlock'" [size]="16" />
              </button>
              <app-menu
                [label]="'More actions for ' + (l.name || label(l))"
                icon="more"
                variant="ghost"
                align="end"
              >
                <button type="button" class="menu-item" role="menuitem" (click)="duplicate(l)">
                  <app-icon name="copy" [size]="16" /> Duplicate
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  (click)="move(l, 'forward')"
                >
                  <app-icon name="arrow-up" [size]="16" /> Bring forward
                </button>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  (click)="move(l, 'backward')"
                >
                  <app-icon name="arrow-down" [size]="16" /> Send backward
                </button>
                <div class="menu-sep"></div>
                <button
                  type="button"
                  class="menu-item menu-item--danger"
                  role="menuitem"
                  (click)="remove(l)"
                >
                  <app-icon name="trash" [size]="16" /> Delete…
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
    return KIND_LABEL[l.type];
  }

  protected kind(l: ArtworkLayer): string {
    return l.type === 'text' && !l.fieldId ? 'Fixed text' : KIND_LABEL[l.type];
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
      title: `Delete “${l.name || this.label(l)}”?`,
      message: customerInput
        ? 'The customer input it feeds is removed too, unless another layer uses it. You can undo this.'
        : 'You can undo this.',
      confirmLabel: 'Delete layer',
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
