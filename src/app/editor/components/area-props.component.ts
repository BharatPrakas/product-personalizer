import { Component, computed, inject } from '@angular/core';
import { PrintSpec } from '../../customizer/models/config.models';
import { PrintableArea } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';
import { ShapeFieldComponent } from './shape-field.component';

/** Properties of a printable area: its own canvas, mask, physical size, boundary and artworks. */
@Component({
  selector: 'app-area-props',
  imports: [CONTROLS, ShapeFieldComponent],
  template: `
    @if (area(); as a) {
      <section class="ed-group">
        <h3 class="ed-title">Printable area</h3>
        <app-text-in
          label="Name"
          [value]="a.name"
          [maxlength]="80"
          (changed)="set({ name: $event || a.name }, 'name')"
        />
        <app-check label="Enabled" [value]="a.enabled" (changed)="set({ enabled: $event })" />
        <p class="ed-hint">
          Its own production canvas: {{ a.canvas.width }} × {{ a.canvas.height }} px, independent of
          the mockup.
        </p>
        <div class="ed-grid">
          <app-num
            label="Canvas width (px)"
            [value]="a.canvas.width"
            [min]="16"
            [max]="4096"
            (changed)="setCanvas({ width: $event })"
          />
          <app-num
            label="Canvas height (px)"
            [value]="a.canvas.height"
            [min]="16"
            [max]="4096"
            (changed)="setCanvas({ height: $event })"
          />
        </div>
        <app-color
          label="Canvas background"
          [allowTransparent]="true"
          [value]="a.canvas.background"
          (changed)="setCanvas({ background: $event })"
        />
        <app-shape-field
          label="Mask shape (print outline)"
          [shape]="a.shape"
          (changed)="set({ shape: $event ?? a.shape }, 'shape')"
        />
      </section>

      <section class="ed-group">
        <h4 class="ed-subtitle">Physical print size</h4>
        <app-check
          label="Warn about low resolution"
          [value]="!!a.print"
          (changed)="togglePrint($event, a)"
        />
        @if (a.print; as p) {
          <div class="ed-grid">
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
      </section>

      <section class="ed-group">
        <h4 class="ed-subtitle">Boundary (editing aid only)</h4>
        <app-check
          label="Show boundary on the mockup"
          [value]="a.boundary?.visible !== false"
          (changed)="setBoundary({ visible: $event })"
        />
        <app-color
          label="Boundary colour"
          [value]="a.boundary?.color ?? '#e11d48'"
          (changed)="setBoundary({ color: $event })"
        />
        <app-num
          label="Boundary opacity (%)"
          [value]="Math.round((a.boundary?.opacity ?? 0.85) * 100)"
          [min]="0"
          [max]="100"
          (changed)="setBoundary({ opacity: $event / 100 })"
        />
        <p class="ed-hint">The boundary is never part of exported artwork.</p>
      </section>

      <section class="ed-group">
        <h4 class="ed-subtitle">Artworks for this area</h4>
        <p class="ed-hint">
          One artwork is shown by default. Add more and customers can choose between them.
        </p>
        <ul class="ed-list">
          @for (art of artworks(); track art.id) {
            <li class="ed-list-row">
              <button
                type="button"
                class="ed-link"
                (click)="store.select({ kind: 'artwork', id: art.id })"
              >
                {{ art.name }}
              </button>
              @if (art.id === a.artworkId) {
                <span class="ed-badge">default</span>
              } @else {
                <button type="button" class="ed-link" (click)="makeDefault(art.id)">
                  Make default
                </button>
              }
            </li>
          }
        </ul>
        <div class="ed-row">
          <button type="button" class="ed-btn" (click)="addArtwork()">Add artwork</button>
          <button type="button" class="ed-btn" (click)="store.editArea(a.id)">Edit artwork</button>
        </div>
      </section>

      <div class="ed-row ed-actions">
        <button type="button" class="ed-btn" (click)="duplicate(a)">Duplicate area</button>
        <button
          type="button"
          class="ed-btn ed-btn-danger"
          [disabled]="(store.config()?.printableAreas?.length ?? 0) <= 1"
          (click)="remove(a)"
        >
          Delete area
        </button>
      </div>
    }
  `,
})
export class AreaPropsComponent {
  protected readonly store = inject(EditorStore);
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
    if (next.minDpi !== undefined && next.warnDpi !== undefined && next.minDpi > next.warnDpi)
      next.minDpi = next.warnDpi;
    this.set({ print: next }, 'print');
  }

  protected setBoundary(patch: Partial<NonNullable<PrintableArea['boundary']>>): void {
    const a = this.area();
    if (a)
      this.set(
        { boundary: { visible: true, color: '#e11d48', opacity: 0.85, ...a.boundary, ...patch } },
        'boundary',
      );
  }

  protected makeDefault(artworkId: string): void {
    const a = this.area();
    if (a) this.store.edit((c) => edit.setDefaultArtwork(c, a.id, artworkId));
  }

  protected addArtwork(): void {
    const a = this.area();
    if (!a) return;
    let created = '';
    this.store.edit((c) => {
      const r = edit.addArtwork(
        c,
        a.id,
        `Artwork ${c.artworks.filter((x) => x.printableAreaId === a.id).length + 1}`,
      );
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

  protected remove(a: PrintableArea): void {
    this.store.edit((c) => edit.removeArea(c, a.id));
  }
}
