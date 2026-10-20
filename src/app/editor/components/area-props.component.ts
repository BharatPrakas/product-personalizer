import { Component, computed, inject } from '@angular/core';
import { PrintSpec } from '../../customizer/models/config.models';
import { PrintableArea } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';
import { PlacementFieldsComponent } from './placement-fields.component';
import { ShapeFieldComponent } from './shape-field.component';

/** Inspector for a printable area: its shape, production canvas, placement, print size and variants. */
@Component({
  selector: 'app-area-props',
  imports: [CONTROLS, ShapeFieldComponent, SectionComponent, PlacementFieldsComponent],
  template: `
    @if (area(); as a) {
      <header class="inspector-head">
        <p class="inspector-kind">Printable area</p>
        <app-text-in
          label="Name"
          [value]="a.name"
          [maxlength]="80"
          (changed)="set({ name: $event || a.name }, 'name')"
        />
      </header>

      <app-section title="Shape and mask">
        <app-shape-field
          label="Shape"
          [shape]="a.shape"
          (changed)="set({ shape: $event ?? a.shape }, 'shape')"
        />
        <p class="field-hint">
          The mask clips the production artwork, so only this shape is printed.
        </p>
      </app-section>

      @if (store.mockup(); as m) {
        @if (placement(); as p) {
          <app-section [title]="'Placement on ' + m.name">
            <app-placement-fields [mockupId]="m.id" [placement]="p" />
          </app-section>
        } @else {
          <app-section [title]="'Placement on ' + m.name">
            <p class="field-hint">This area is not placed on the selected photo.</p>
            <button type="button" class="btn btn--sm" (click)="place(m.id, a)">
              Place on this photo
            </button>
          </app-section>
        }
      }

      <app-section title="Production canvas">
        <p class="field-hint">
          The artwork is designed and exported at this size, independent of where it sits on a
          mockup.
        </p>
        <div class="grid-2">
          <app-num
            label="Width (px)"
            [value]="a.canvas.width"
            [min]="16"
            [max]="4096"
            (changed)="setCanvas({ width: $event })"
          />
          <app-num
            label="Height (px)"
            [value]="a.canvas.height"
            [min]="16"
            [max]="4096"
            (changed)="setCanvas({ height: $event })"
          />
        </div>
        <app-color
          label="Background"
          [allowTransparent]="true"
          [value]="a.canvas.background"
          (changed)="setCanvas({ background: $event })"
        />
      </app-section>

      <app-section title="Artwork" [open]="false">
        <p class="field-hint">
          The design shown for this area. Offer several and customers choose.
        </p>
        <ul class="plain-list">
          @for (art of artworks(); track art.id) {
            <li class="list-row-simple">
              <button
                type="button"
                class="link-btn"
                (click)="store.select({ kind: 'artwork', id: art.id })"
              >
                {{ art.name }}
              </button>
              @if (art.id === a.artworkId && artworks().length > 1) {
                <span class="badge badge--info">Default</span>
              }
            </li>
          }
        </ul>
        <div class="row">
          <button type="button" class="btn btn--sm" (click)="store.editArea(a.id)">
            Edit artwork
          </button>
          <button type="button" class="btn btn--sm" (click)="addArtwork(a)">Add another</button>
        </div>
      </app-section>

      <app-section title="Variants" [open]="false">
        <p class="field-hint">Choose which variants include this printable area.</p>
        @for (v of store.config()?.variants ?? []; track v.id) {
          <app-check
            [label]="v.label"
            [value]="v.printableAreaIds.includes(a.id)"
            (changed)="toggleVariant(v.id, a.id, $event)"
          />
        }
        <app-check label="Enabled" [value]="a.enabled" (changed)="set({ enabled: $event })" />
      </app-section>

      <app-section title="Print size and resolution" [open]="false">
        <app-check
          label="Warn about low-resolution photos"
          [value]="!!a.print"
          (changed)="togglePrint($event, a)"
        />
        @if (a.print; as p) {
          <div class="grid-2">
            <app-num
              label="Width (mm)"
              [value]="p.widthMm"
              [min]="1"
              step="0.5"
              (changed)="setPrint({ widthMm: $event })"
            />
            <app-num
              label="Height (mm)"
              [value]="p.heightMm"
              [min]="1"
              step="0.5"
              (changed)="setPrint({ heightMm: $event })"
            />
            <app-num
              label="Warn below (DPI)"
              [value]="p.warnDpi ?? 150"
              [min]="150"
              [max]="1000"
              (changed)="setPrint({ warnDpi: $event })"
            />
            <app-num
              label="Block below (DPI)"
              [value]="p.minDpi ?? 0"
              [min]="0"
              [max]="1000"
              (changed)="setPrint({ minDpi: $event >= 100 ? $event : undefined })"
            />
          </div>
        }
        <p class="field-hint">
          Exported pixels do not guarantee print quality; this uses the physical size you enter.
        </p>
      </app-section>

      <app-section title="Boundary display" [open]="false">
        <app-check
          label="Show boundary on mockups"
          [value]="a.boundary?.visible !== false"
          (changed)="setBoundary({ visible: $event })"
        />
        <app-color
          label="Colour"
          [value]="a.boundary?.color ?? '#e11d48'"
          (changed)="setBoundary({ color: $event })"
        />
        <app-num
          label="Opacity (%)"
          [value]="Math.round((a.boundary?.opacity ?? 0.85) * 100)"
          [min]="0"
          [max]="100"
          (changed)="setBoundary({ opacity: $event / 100 })"
        />
        <p class="field-hint">
          An editing aid only: boundaries never appear in exports or the customer preview.
        </p>
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm" (click)="duplicate(a)">Duplicate</button>
        <button type="button" class="btn btn--sm btn--danger" (click)="remove(a)">Delete…</button>
      </div>
    }
  `,
})
export class AreaPropsComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);
  protected readonly Math = Math;

  protected readonly area = computed<PrintableArea | null>(() => {
    const s = this.store.selection();
    const c = this.store.config();
    return s.kind === 'area' ? (c?.printableAreas.find((a) => a.id === s.id) ?? null) : null;
  });
  protected readonly artworks = computed(() => {
    const c = this.store.config();
    const a = this.area();
    return c && a ? c.artworks.filter((x) => x.printableAreaId === a.id) : [];
  });
  protected readonly placement = computed(() => {
    const a = this.area();
    return a ? this.store.placementFor(a.id) : null;
  });

  protected set(patch: Partial<PrintableArea>, key?: string): void {
    const a = this.area();
    if (!a) return;
    this.store.edit(
      (c) => edit.updateArea(c, a.id, patch),
      key ? `area:${a.id}:${key}` : undefined,
    );
  }

  protected setCanvas(patch: Partial<PrintableArea['canvas']>): void {
    const a = this.area();
    if (a) this.set({ canvas: { ...a.canvas, ...patch } }, 'canvas');
  }

  protected place(mockupId: string, a: PrintableArea): void {
    const size = this.store.mockupSize(mockupId);
    if (size) {
      this.store.edit((c) =>
        edit.setPlacement(c, mockupId, edit.defaultPlacement(a, size.w, size.h)),
      );
    }
  }

  protected togglePrint(on: boolean, a: PrintableArea): void {
    const aspect = a.canvas.width / a.canvas.height;
    this.set({
      print: on
        ? { widthMm: 300, heightMm: Math.round((300 / aspect) * 100) / 100, warnDpi: 150 }
        : undefined,
    });
  }

  protected setPrint(patch: Partial<PrintSpec>): void {
    const a = this.area();
    if (!a?.print) return;
    const next: PrintSpec = { ...a.print, ...patch };
    if (patch.minDpi === undefined && 'minDpi' in patch) delete next.minDpi;
    if (next.minDpi !== undefined && next.warnDpi !== undefined && next.minDpi > next.warnDpi) {
      next.minDpi = next.warnDpi;
    }
    this.set({ print: next }, 'print');
  }

  protected setBoundary(patch: Partial<NonNullable<PrintableArea['boundary']>>): void {
    const a = this.area();
    if (a) {
      this.set(
        { boundary: { visible: true, color: '#e11d48', opacity: 0.85, ...a.boundary, ...patch } },
        'boundary',
      );
    }
  }

  protected toggleVariant(variantId: string, areaId: string, on: boolean): void {
    this.store.edit((c) => edit.toggleVariantArea(c, variantId, areaId, on));
  }

  protected addArtwork(a: PrintableArea): void {
    let created = '';
    this.store.edit((c) => {
      const n = c.artworks.filter((x) => x.printableAreaId === a.id).length + 1;
      const r = edit.addArtwork(c, a.id, `${a.name} design ${n}`);
      created = r.id;
      return r.config;
    });
    if (created) this.store.select({ kind: 'artwork', id: created });
  }

  protected duplicate(a: PrintableArea): void {
    let created = '';
    this.store.edit((c) => {
      const r = edit.duplicateArea(c, a.id);
      created = r?.areaId ?? '';
      return r?.config ?? c;
    });
    if (created) this.store.select({ kind: 'area', id: created });
  }

  protected async remove(a: PrintableArea): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: `Delete “${a.name}”?`,
      message:
        'The area, its artworks, layers and customer inputs, and its placements are deleted. You can undo this.',
      confirmLabel: 'Delete area',
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeArea(c, a.id));
  }
}
