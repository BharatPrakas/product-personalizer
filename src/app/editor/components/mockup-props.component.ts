import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
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
  imports: [CONTROLS, SectionComponent, PlacementFieldsComponent, TranslatePipe],
  template: `
    @if (mockup(); as m) {
      <header class="inspector-head">
        <p class="inspector-kind">{{ 'inspector.mockup' | t }}</p>
        <app-text-in
          [label]="'inspector.name' | t"
          [value]="m.name"
          [maxlength]="80"
          (changed)="set({ name: $event || m.name }, 'name')"
        />
      </header>

      <app-section [title]="'inspector.mockup.photo' | t">
        <p class="field-hint">
          {{ 'inspector.mockup.photo-hint' | t: { size: photoSize() } }}
        </p>
        <div class="row">
          <app-file [label]="'inspector.mockup.replace' | t" (chosen)="replace($event)" />
        </div>
        <app-check
          [label]="'mockups.visible-tip' | t"
          [value]="m.visible !== false"
          (changed)="set({ visible: $event ? undefined : false })"
        />
        <app-check
          [label]="'inspector.mockup.default-view' | t"
          [value]="store.config()?.preview?.defaultMockupId === m.id"
          (changed)="setDefaultView($event)"
        />
      </app-section>

      <app-section [title]="'inspector.variants' | t">
        <p class="field-hint">{{ 'inspector.mockup.variants-hint' | t }}</p>
        @for (v of store.config()?.variants ?? []; track v.id) {
          <app-check
            [label]="v.label"
            [value]="v.mockupIds.includes(m.id)"
            (changed)="toggleVariant(v.id, m.id, $event)"
          />
        }
      </app-section>

      <app-section [title]="'inspector.mockup.areas' | t">
        @if (m.placements.length === 0) {
          <p class="field-hint">{{ 'inspector.mockup.no-areas' | t }}</p>
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
                {{ 'common.remove' | t }}
              </button>
            </div>
            <app-placement-fields [mockupId]="m.id" [placement]="p" />
          </div>
        }
        @if (unplaced().length > 0) {
          <div class="row">
            @for (a of unplaced(); track a.id) {
              <button type="button" class="btn btn--sm" (click)="place(a.id)">
                {{ 'inspector.mockup.place' | t: { name: a.name } }}
              </button>
            }
          </div>
        }
        <button type="button" class="btn btn--sm" (click)="store.addAreaDialogOpen.set(true)">
          {{ 'inspector.mockup.add-area' | t }}
        </button>
      </app-section>

      <app-section [title]="'inspector.mockup.overlays' | t" [open]="false">
        <p class="field-hint">
          {{ 'inspector.mockup.overlays-hint' | t }}
        </p>
        @for (o of m.overlays ?? []; track o.id) {
          <div class="row">
            <span class="grow truncate">{{
              'inspector.mockup.overlay-n' | t: { n: $index + 1 }
            }}</span>
            <app-num
              [label]="'inspector.opacity' | t"
              [value]="round((o.opacity ?? 1) * 100)"
              [min]="0"
              [max]="100"
              (changed)="setOverlayOpacity(o.id, $event)"
            />
            <button type="button" class="btn btn--sm btn--danger" (click)="removeOverlay(o.id)">
              {{ 'common.remove' | t }}
            </button>
          </div>
        }
        <app-file
          [label]="'inspector.mockup.add-overlay' | t"
          accept="image/png,image/webp"
          (chosen)="addOverlay($event)"
        />
      </app-section>

      <div class="panel-actions row">
        <button type="button" class="btn btn--sm btn--danger" (click)="remove(m)">
          {{ 'inspector.mockup.remove-btn' | t }}
        </button>
      </div>
    }
  `,
})
export class MockupPropsComponent {
  private readonly i18n = inject(I18n);
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

  protected photoSize(): string {
    const size = this.size();
    return size
      ? this.i18n.t('inspector.mockup.size', { width: size.w, height: size.h })
      : this.i18n.t('inspector.mockup.photo-loading');
  }

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
      title: this.i18n.t('mockups.remove.title', { name: m.name }),
      message: this.i18n.t('inspector.mockup.remove.message'),
      confirmLabel: this.i18n.t('mockups.remove.confirm'),
      danger: true,
    });
    if (ok) this.store.edit((c) => edit.removeMockup(c, m.id));
  }
}
