import { Component, computed, inject } from '@angular/core';
import { ProductMockup } from '../../customizer/models/product.models';
import { ConfirmService } from '../../ui/confirm.service';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';
import { PlacementFieldsComponent } from './placement-fields.component';

/** Inspector for a mockup: the photo, which variants show it, its printable-area placements and overlays. */
@Component({
  selector: 'app-mockup-props',
  imports: [CONTROLS, SectionComponent, PlacementFieldsComponent],
  template: `
    @if (mockup(); as m) {
      <header class="inspector-head">
        <p class="inspector-kind">Mockup</p>
        <app-text-in
          label="Name"
          [value]="m.name"
          [maxlength]="80"
          (changed)="set({ name: $event || m.name }, 'name')"
        />
      </header>

      <app-section title="Photo">
        <p class="field-hint">
          {{ size() ? size()!.w + ' × ' + size()!.h + ' px' : 'Loading the photo…' }}. A mockup is
          only the product photo; the artwork is designed separately for each printable area.
        </p>
        <div class="row">
          <app-file label="Replace photo" (chosen)="replace($event)" />
        </div>
        <app-check
          label="Visible to customers"
          [value]="m.visible !== false"
          (changed)="set({ visible: $event ? undefined : false })"
        />
        <app-check
          label="Show this view first"
          [value]="store.config()?.preview?.defaultMockupId === m.id"
          (changed)="setDefaultView($event)"
        />
      </app-section>

      <app-section title="Variants">
        <p class="field-hint">Customers see this photo for the variants you tick.</p>
        @for (v of store.config()?.variants ?? []; track v.id) {
          <app-check
            [label]="v.label"
            [value]="v.mockupIds.includes(m.id)"
            (changed)="toggleVariant(v.id, m.id, $event)"
          />
        }
      </app-section>

      <app-section title="Printable areas on this photo">
        @if (m.placements.length === 0) {
          <p class="field-hint">No printable area is placed on this photo yet.</p>
        }
        @for (p of m.placements; track p.printableAreaId) {
          <div class="mini-card">
            <div class="row">
              <button
                type="button"
                class="link-btn grow"
                (click)="store.select({ kind: 'area', id: p.printableAreaId })"
              >
                {{ areaName(p.printableAreaId) }}
              </button>
              <button
                type="button"
                class="link-btn text-danger"
                (click)="removePlacement(p.printableAreaId)"
              >
                Remove
              </button>
            </div>
            <app-placement-fields [mockupId]="m.id" [placement]="p" />
          </div>
        }
        @if (unplaced().length > 0) {
          <div class="row">
            @for (a of unplaced(); track a.id) {
              <button type="button" class="btn btn--sm" (click)="place(a.id)">
                Place “{{ a.name }}”
              </button>
            }
          </div>
        }
        <button type="button" class="btn btn--sm" (click)="store.addAreaDialogOpen.set(true)">
          Add printable area…
        </button>
      </app-section>

      <app-section title="Foreground overlays" [open]="false">
        <p class="field-hint">
          Transparent images drawn above the artwork, such as glass, clock hands or highlights.
        </p>
        @for (o of m.overlays ?? []; track o.id) {
          <div class="row">
            <span class="grow truncate">Overlay {{ $index + 1 }}</span>
            <app-num
              label="Opacity (%)"
              [value]="round((o.opacity ?? 1) * 100)"
              [min]="0"
              [max]="100"
              (changed)="setOverlayOpacity(o.id, $event)"
            />
            <button type="button" class="btn btn--sm btn--danger" (click)="removeOverlay(o.id)">
              Remove
            </button>
          </div>
        }
        <app-file
          label="Add overlay image"
          accept="image/png,image/webp"
          (chosen)="addOverlay($event)"
        />
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm btn--danger" (click)="remove(m)">
          Remove mockup…
        </button>
      </div>
    }
  `,
})
export class MockupPropsComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);

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

  protected areaName(id: string): string {
    return this.store.config()?.printableAreas.find((a) => a.id === id)?.name ?? id;
  }

  protected set(patch: Parameters<typeof edit.updateMockup>[2], key?: string): void {
    const m = this.mockup();
    if (m) {
      this.store.edit(
        (c) => edit.updateMockup(c, m.id, patch),
        key ? `mockup:${m.id}:${key}` : undefined,
      );
    }
  }

  protected setDefaultView(on: boolean): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.setDefaultMockup(c, on ? m.id : undefined));
  }

  protected async replace(file: File): Promise<void> {
    const src = await this.store.uploadImage(file);
    if (src) this.set({ src });
  }

  protected toggleVariant(variantId: string, mockupId: string, on: boolean): void {
    this.store.edit((c) => edit.toggleVariantMockup(c, variantId, mockupId, on));
  }

  protected removePlacement(areaId: string): void {
    const m = this.mockup();
    if (m) this.store.edit((c) => edit.setPlacement(c, m.id, null, areaId));
  }

  protected place(areaId: string): void {
    const m = this.mockup();
    const size = this.size();
    const area = this.store.config()?.printableAreas.find((a) => a.id === areaId);
    if (m && size && area) {
      this.store.edit((c) =>
        edit.setPlacement(c, m.id, edit.defaultPlacement(area, size.w, size.h)),
      );
    }
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

  protected async addOverlay(file: File): Promise<void> {
    const m = this.mockup();
    const src = await this.store.uploadImage(file);
    if (m && src) this.store.edit((c) => edit.addOverlay(c, m.id, src));
  }

  protected async remove(m: ProductMockup): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: `Remove “${m.name}”?`,
      message:
        'Its placements are removed with it; printable areas and artwork are kept. You can undo this.',
      confirmLabel: 'Remove mockup',
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeMockup(c, m.id));
  }
}
