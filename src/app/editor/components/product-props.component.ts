import { Component, computed, inject } from '@angular/core';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS, Option } from './controls.component';

/** Product-level settings, variants (with their mockup and printable-area mappings) and validation. */
@Component({
  selector: 'app-product-props',
  imports: [CONTROLS],
  template: `
    @if (store.config(); as c) {
      @if (variant(); as v) {
        <section class="ed-group">
          <h3 class="ed-title">Variant</h3>
          <app-text-in
            label="Label"
            [value]="v.label"
            [maxlength]="60"
            (changed)="setLabel($event)"
          />
          <app-color
            label="Colour chip"
            [allowTransparent]="true"
            [value]="v.swatch ?? 'transparent'"
            (changed)="setSwatch($event)"
          />
          <fieldset class="ed-fieldset">
            <legend class="ed-label">Mockups that show this variant</legend>
            @for (m of c.mockups; track m.id) {
              <app-check
                [label]="m.name"
                [value]="v.mockupIds.includes(m.id)"
                (changed)="toggleMockup(m.id, $event)"
              />
            }
          </fieldset>
          <fieldset class="ed-fieldset">
            <legend class="ed-label">Printable areas enabled for this variant</legend>
            @for (a of c.printableAreas; track a.id) {
              <app-check
                [label]="a.name"
                [value]="v.printableAreaIds.includes(a.id)"
                (changed)="toggleArea(a.id, $event)"
              />
            }
          </fieldset>
          <div class="ed-row ed-actions">
            <button
              type="button"
              class="ed-btn ed-btn-danger"
              [disabled]="c.variants.length <= 1"
              (click)="removeVariant(v.id)"
            >
              Delete variant
            </button>
          </div>
        </section>
      } @else {
        <section class="ed-group">
          <h3 class="ed-title">Product</h3>
          <app-text-in
            label="Product name"
            [value]="c.product.name"
            [maxlength]="120"
            (changed)="setName($event)"
          />
          <app-select
            label="Status"
            [options]="statusOptions"
            [value]="c.status"
            (changed)="setStatus($event)"
          />
          <dl class="ed-facts">
            <dt>Configuration id</dt>
            <dd>
              <code>{{ c.id }}</code>
            </dd>
            <dt>Version</dt>
            <dd>{{ c.version }} (increases on each save of a published configuration)</dd>
            <dt>Product id</dt>
            <dd>
              <code>{{ c.product.id }}</code>
            </dd>
            <dt>Schema</dt>
            <dd>version {{ c.schemaVersion }}</dd>
          </dl>
        </section>

        <section class="ed-group">
          <h4 class="ed-subtitle">Variants</h4>
          <ul class="ed-list">
            @for (v of c.variants; track v.id) {
              <li class="ed-list-row">
                <button
                  type="button"
                  class="ed-link"
                  (click)="store.select({ kind: 'variant', id: v.id })"
                >
                  {{ v.label }}
                </button>
                <span class="ed-hint"
                  >{{ v.mockupIds.length }} mockup(s), {{ v.printableAreaIds.length }} area(s)</span
                >
              </li>
            }
          </ul>
          <button type="button" class="ed-btn" (click)="addVariant()">Add variant</button>
        </section>

        <section class="ed-group" aria-label="Configuration problems">
          <h4 class="ed-subtitle">Configuration check</h4>
          @if (store.issues().length === 0) {
            <p class="ed-ok">The configuration is valid.</p>
          } @else {
            <ul class="ed-issues">
              @for (issue of store.issues().slice(0, 12); track $index) {
                <li>
                  <code>{{ issue.path || 'config' }}</code> {{ issue.message }}
                </li>
              }
            </ul>
          }
        </section>
      }
    }
  `,
})
export class ProductPropsComponent {
  protected readonly store = inject(EditorStore);
  protected readonly edit = edit;
  protected readonly statusOptions: Option[] = [
    { value: 'draft', label: 'Draft' },
    { value: 'published', label: 'Published' },
  ];
  protected readonly variant = computed(() => {
    const s = this.store.selection();
    return s.kind === 'variant'
      ? (this.store.config()?.variants.find((v) => v.id === s.id) ?? null)
      : null;
  });

  protected setName(name: string): void {
    if (name) this.store.edit((c) => edit.patchProduct(c, { name }), 'product-name');
  }

  protected setStatus(value: string): void {
    this.store.edit((c) =>
      edit.patchProduct(c, { status: value === 'published' ? 'published' : 'draft' }),
    );
  }

  protected setLabel(label: string): void {
    const v = this.variant();
    if (v && label)
      this.store.edit((c) => edit.updateVariant(c, v.id, { label }), `variant:${v.id}`);
  }

  protected setSwatch(value: string): void {
    const v = this.variant();
    if (v) {
      this.store.edit(
        (c) => edit.updateVariant(c, v.id, { swatch: value === 'transparent' ? undefined : value }),
        `variant-color:${v.id}`,
      );
    }
  }

  protected toggleMockup(mockupId: string, on: boolean): void {
    const v = this.variant();
    if (v) this.store.edit((c) => edit.toggleVariantMockup(c, v.id, mockupId, on));
  }

  protected toggleArea(areaId: string, on: boolean): void {
    const v = this.variant();
    if (v) this.store.edit((c) => edit.toggleVariantArea(c, v.id, areaId, on));
  }

  protected addVariant(): void {
    let created = '';
    this.store.edit((c) => {
      const r = edit.addVariant(c, `Variant ${c.variants.length + 1}`);
      created = r.id;
      return r.config;
    });
    if (created) this.store.select({ kind: 'variant', id: created });
  }

  protected removeVariant(id: string): void {
    this.store.edit((c) => edit.removeVariant(c, id));
    this.store.select({ kind: 'product' });
  }
}
