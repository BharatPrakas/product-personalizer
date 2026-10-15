import { Component, computed, inject } from '@angular/core';
import { AreaPlacement, ProductMockup } from '../../customizer/models/product.models';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';

const BLEND: Option[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply (fabric)' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft light' },
];

/** Properties of a mockup: image, visibility, variant assignment, area placements and overlays. */
@Component({
  selector: 'app-mockup-props',
  imports: [CONTROLS],
  template: `
    @if (mockup(); as m) {
      <section class="ed-group">
        <h3 class="ed-title">Mockup</h3>
        <app-text-in
          label="Name"
          [value]="m.name"
          [maxlength]="80"
          (changed)="set({ name: $event || m.name }, 'name')"
        />
        <p class="ed-hint">
          {{ size() ? size()!.w + ' × ' + size()!.h + ' px photograph' : 'Loading image…' }}. A
          mockup is only the product photo; the production canvases are separate.
        </p>
        <div class="ed-row">
          <app-file label="Replace image" (chosen)="replace($event)" />
          <app-check
            label="Visible to customers"
            [value]="m.visible !== false"
            (changed)="set({ visible: $event ? undefined : false })"
          />
        </div>
        <app-check
          label="Show this view first"
          [value]="store.config()?.preview?.defaultMockupId === m.id"
          (changed)="setDefaultView($event)"
        />
      </section>

      <section class="ed-group">
        <h4 class="ed-subtitle">Applies to variants</h4>
        @for (v of store.config()?.variants ?? []; track v.id) {
          <app-check
            [label]="v.label"
            [value]="v.mockupIds.includes(m.id)"
            (changed)="toggleVariant(v.id, m.id, $event)"
          />
        }
      </section>

      <section class="ed-group">
        <h4 class="ed-subtitle">Printable areas on this mockup</h4>
        <p class="ed-hint">
          Placements are stored as fractions of the photograph, so resizing the editor never changes
          them.
        </p>
        @for (p of m.placements; track p.printableAreaId) {
          <div class="ed-card">
            <div class="ed-row">
              <button
                type="button"
                class="ed-link"
                (click)="store.select({ kind: 'area', id: p.printableAreaId })"
              >
                {{ areaName(p.printableAreaId) }}
              </button>
              <button
                type="button"
                class="ed-link ed-danger"
                (click)="removePlacement(p.printableAreaId)"
              >
                Remove
              </button>
            </div>
            @if (size(); as s) {
              <div class="ed-grid">
                <app-num
                  label="X (px)"
                  [value]="round(p.x * s.w)"
                  (changed)="patchPlacement(p, { x: $event / s.w })"
                />
                <app-num
                  label="Y (px)"
                  [value]="round(p.y * s.h)"
                  (changed)="patchPlacement(p, { y: $event / s.h })"
                />
                <app-num
                  label="Width (px)"
                  [value]="round(p.width * s.w)"
                  [min]="4"
                  (changed)="patchPlacement(p, { width: $event / s.w })"
                />
                <app-num
                  label="Height (px)"
                  [value]="round(p.height * s.h)"
                  [min]="4"
                  (changed)="patchPlacement(p, { height: $event / s.h })"
                />
                <app-num
                  label="Rotation (°)"
                  [value]="p.rotation ?? 0"
                  [min]="-360"
                  [max]="360"
                  step="0.5"
                  [disabled]="p.type === 'quad'"
                  (changed)="patchPlacement(p, { rotation: $event || undefined })"
                />
                <app-num
                  label="Opacity (%)"
                  [value]="round((p.opacity ?? 1) * 100)"
                  [min]="0"
                  [max]="100"
                  (changed)="
                    patchPlacement(p, { opacity: $event >= 100 ? undefined : $event / 100 })
                  "
                />
              </div>
            }
            <app-select
              label="Blend"
              [options]="blend"
              [value]="p.blendMode ?? 'normal'"
              (changed)="setBlend(p, $event)"
            />
            <div class="ed-row">
              <app-check
                label="Perspective (4 corners)"
                [value]="p.type === 'quad'"
                (changed)="togglePerspective(p, $event)"
              />
              <button type="button" class="ed-link" (click)="matchAspect(p)">
                Match canvas aspect
              </button>
            </div>
          </div>
        }
        @if (unplaced().length > 0) {
          <div class="ed-row">
            @for (a of unplaced(); track a.id) {
              <button type="button" class="ed-btn" (click)="place(a.id)">
                Place “{{ a.name }}”
              </button>
            }
          </div>
        }
      </section>

      <section class="ed-group">
        <h4 class="ed-subtitle">Foreground overlays</h4>
        <p class="ed-hint">
          Transparent images drawn above the customer's artwork (glass, hands, highlights).
        </p>
        @for (o of m.overlays ?? []; track o.id) {
          <div class="ed-row">
            <span class="ed-grow">{{ o.id }}</span>
            <app-num
              label="Opacity (%)"
              [value]="round((o.opacity ?? 1) * 100)"
              [min]="0"
              [max]="100"
              (changed)="setOverlayOpacity(o.id, $event)"
            />
            <button type="button" class="ed-link ed-danger" (click)="removeOverlay(o.id)">
              Remove
            </button>
          </div>
        }
        <app-file
          label="Add overlay image"
          accept="image/png,image/webp"
          (chosen)="addOverlay($event)"
        />
      </section>

      <div class="ed-row ed-actions">
        <button type="button" class="ed-btn" (click)="move(-1)">Move earlier</button>
        <button type="button" class="ed-btn" (click)="move(1)">Move later</button>
        <button
          type="button"
          class="ed-btn ed-btn-danger"
          [disabled]="(store.config()?.mockups?.length ?? 0) <= 1"
          (click)="remove()"
        >
          Delete mockup
        </button>
      </div>
    }
  `,
})
export class MockupPropsComponent {
  protected readonly store = inject(EditorStore);
  protected readonly edit = edit;
  protected readonly blend = BLEND;

  protected readonly mockup = computed<ProductMockup | null>(() => {
    const s = this.store.selection();
    const c = this.store.config();
    return s.kind === 'mockup' ? (c?.mockups.find((m) => m.id === s.id) ?? null) : null;
  });
  protected readonly size = computed(() => {
    const m = this.mockup();
    return m ? this.store.mockupSize(m.id) : null;
  });
  protected readonly unplaced = computed(() => {
    const m = this.mockup();
    const c = this.store.config();
    if (!m || !c) return [];
    return c.printableAreas.filter((a) => !m.placements.some((p) => p.printableAreaId === a.id));
  });

  protected round(n: number): number {
    return Math.round(n);
  }

  protected setDefaultView(on: boolean): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.setDefaultMockup(c, on ? m.id : undefined));
  }

  protected setBlend(p: AreaPlacement, value: string): void {
    const blendMode =
      BLEND.some((b) => b.value === value) && value !== 'normal'
        ? (value as AreaPlacement['blendMode'])
        : undefined;
    this.patchPlacement(p, { blendMode });
  }

  protected setOverlayOpacity(overlayId: string, percent: number): void {
    const m = this.mockup();
    if (m) {
      this.store.edit(
        (c) =>
          edit.updateOverlay(c, m.id, overlayId, {
            opacity: percent >= 100 ? undefined : percent / 100,
          }),
        `overlay:${overlayId}`,
      );
    }
  }

  protected removeOverlay(overlayId: string): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.removeOverlay(c, m.id, overlayId));
  }

  protected areaName(id: string): string {
    return this.store.config()?.printableAreas.find((a) => a.id === id)?.name ?? id;
  }

  protected set(patch: Parameters<typeof edit.updateMockup>[2], key?: string): void {
    const m = this.mockup();
    if (m)
      this.store.edit(
        (c) => edit.updateMockup(c, m.id, patch),
        key ? `mockup:${m.id}:${key}` : undefined,
      );
  }

  protected async replace(file: File): Promise<void> {
    const src = await this.store.uploadImage(file);
    if (src) this.set({ src });
  }

  protected toggleVariant(variantId: string, mockupId: string, on: boolean): void {
    this.store.edit((c) => edit.toggleVariantMockup(c, variantId, mockupId, on));
  }

  protected patchPlacement(p: AreaPlacement, patch: Partial<AreaPlacement>): void {
    const m = this.mockup();
    if (m)
      this.store.edit(
        (c) => edit.updatePlacement(c, m.id, p.printableAreaId, patch),
        `placement:${p.printableAreaId}:${Object.keys(patch)[0]}`,
      );
  }

  protected removePlacement(areaId: string): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.setPlacement(c, m.id, null, areaId));
  }

  protected place(areaId: string): void {
    const m = this.mockup();
    const size = this.size();
    const area = this.store.config()?.printableAreas.find((a) => a.id === areaId);
    if (m && size && area)
      this.store.edit((c) =>
        edit.setPlacement(c, m.id, edit.defaultPlacement(area, size.w, size.h)),
      );
  }

  /** Resize the placement (about its centre) so its pixel aspect equals the area canvas aspect. */
  protected matchAspect(p: AreaPlacement): void {
    const size = this.size();
    const area = this.store.config()?.printableAreas.find((a) => a.id === p.printableAreaId);
    if (!size || !area) return;
    const aspect = area.canvas.width / area.canvas.height;
    const wPx = p.width * size.w;
    const hPx = wPx / aspect;
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    this.patchPlacement(p, {
      width: p.width,
      height: hPx / size.h,
      y: cy - hPx / size.h / 2,
      x: cx - p.width / 2,
    });
  }

  protected togglePerspective(p: AreaPlacement, on: boolean): void {
    if (on) {
      const x1 = p.x + p.width;
      const y1 = p.y + p.height;
      this.patchPlacement(p, {
        type: 'quad',
        rotation: undefined,
        corners: [
          [p.x, p.y],
          [x1, p.y],
          [x1, y1],
          [p.x, y1],
        ],
      });
    } else {
      this.patchPlacement(p, { type: 'rect', corners: undefined });
    }
  }

  protected async addOverlay(file: File): Promise<void> {
    const m = this.mockup();
    const src = await this.store.uploadImage(file);
    if (m && src) this.store.edit((c) => edit.addOverlay(c, m.id, src));
  }

  protected move(direction: -1 | 1): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.moveMockup(c, m.id, direction));
  }

  protected remove(): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.removeMockup(c, m.id));
  }
}
