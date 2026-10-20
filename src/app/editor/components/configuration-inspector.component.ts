import { Component, computed, inject } from '@angular/core';
import { relativeTime } from '../../configurations/relative-time';
import { ConfirmService } from '../../ui/confirm.service';
import { IconComponent } from '../../ui/icon.component';
import { SectionComponent } from '../../ui/section.component';
import { EditorStore } from '../services/editor-store.service';
import * as edit from '../util/config-edit';
import { CONTROLS } from './controls.component';

/** What the inspector shows when nothing is selected: the configuration itself, its setup progress and variants. */
@Component({
  selector: 'app-configuration-inspector',
  imports: [CONTROLS, SectionComponent, IconComponent],
  template: `
    @if (store.config(); as c) {
      @if (variant(); as v) {
        <header class="inspector-head">
          <p class="inspector-kind">Variant</p>
          <app-text-in
            label="Name"
            [value]="v.label"
            [maxlength]="60"
            (changed)="setLabel($event)"
          />
        </header>
        <app-section title="Appearance">
          <app-color
            label="Colour chip shown to customers"
            [allowTransparent]="true"
            [value]="v.swatch ?? 'transparent'"
            (changed)="setSwatch($event)"
          />
        </app-section>
        <app-section title="Mockups for this variant">
          @if (c.mockups.length === 0) {
            <p class="field-hint">Add a mockup first.</p>
          }
          @for (m of c.mockups; track m.id) {
            <app-check
              [label]="m.name"
              [value]="v.mockupIds.includes(m.id)"
              (changed)="toggleMockup(m.id, $event)"
            />
          }
        </app-section>
        <app-section title="Printable areas for this variant">
          @if (c.printableAreas.length === 0) {
            <p class="field-hint">Add a printable area first.</p>
          }
          @for (a of c.printableAreas; track a.id) {
            <app-check
              [label]="a.name"
              [value]="v.printableAreaIds.includes(a.id)"
              (changed)="toggleArea(a.id, $event)"
            />
          }
        </app-section>
        <div class="panel-actions row">
          <button type="button" class="btn btn--sm" (click)="store.select({ kind: 'product' })">
            Back to configuration
          </button>
          <button
            type="button"
            class="btn btn--sm btn--danger"
            [disabled]="c.variants.length <= 1"
            (click)="removeVariant(v.id)"
          >
            Delete variant…
          </button>
        </div>
      } @else {
        <header class="inspector-head">
          <p class="inspector-kind">Configuration</p>
          <app-text-in
            label="Name"
            [value]="c.product.name"
            [maxlength]="120"
            (changed)="setName($event)"
          />
        </header>

        <app-section [title]="store.publishable() ? 'Ready to publish' : 'Setup'">
          <ol class="steps">
            @for (step of store.steps(); track step.id) {
              <li class="step" [class.is-done]="step.done">
                <app-icon [name]="step.done ? 'circle-check' : 'circle-empty'" [size]="18" />
                <span class="step-text">
                  <span class="step-label">{{ step.label }}</span>
                  @if (!step.done) {
                    <span class="step-hint">{{ step.hint }}</span>
                  }
                </span>
              </li>
            }
          </ol>
          @if (store.issues().length > 0) {
            <ul class="issue-list" aria-label="Problems">
              @for (issue of store.issues().slice(0, 6); track $index) {
                <li>{{ issue.message }}</li>
              }
            </ul>
          }
        </app-section>

        <app-section title="Publishing">
          @if (store.published() && store.record(); as record) {
            <p class="field-hint">
              Published {{ publishedAgo() }}.
              {{
                store.unpublishedChanges()
                  ? 'The draft has changes that are not published yet.'
                  : 'The draft matches the published configuration.'
              }}
            </p>
          } @else {
            <p class="field-hint">
              Not published yet. Saving stores a draft; publishing makes the current design the
              published configuration.
            </p>
          }
          <p class="field-hint">{{ repoLabel() }}</p>
        </app-section>

        <app-section title="Variants">
          <ul class="plain-list">
            @for (v of c.variants; track v.id) {
              <li class="list-row-simple">
                <button
                  type="button"
                  class="link-btn"
                  (click)="store.select({ kind: 'variant', id: v.id })"
                >
                  {{ v.label }}
                </button>
                <span class="field-hint"
                  >{{ v.mockupIds.length }} mockups · {{ v.printableAreaIds.length }} areas</span
                >
              </li>
            }
          </ul>
          <button type="button" class="btn btn--sm" (click)="addVariant()">Add variant</button>
        </app-section>

        <app-section title="Editor view" [open]="false">
          <app-check
            label="Show area boundaries on the product photo"
            [value]="store.showBoundaries()"
            (changed)="store.showBoundaries.set($event)"
          />
          <app-check
            label="Fill customer slots with sample photos"
            [value]="store.sampleContent()"
            (changed)="store.setSampleContent($event)"
          />
          <p class="field-hint">
            These only affect what you see while editing, never what customers see or what is
            exported.
          </p>
        </app-section>

        <app-section title="Technical details" [open]="false">
          <dl class="facts">
            <dt>Configuration ID</dt>
            <dd>
              <code>{{ c.id }}</code>
            </dd>
            <dt>Draft version</dt>
            <dd>{{ c.version }}</dd>
            <dt>Schema</dt>
            <dd>Version {{ c.schemaVersion }}</dd>
          </dl>
        </app-section>
      }
    }
  `,
})
export class ConfigurationInspectorComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);

  protected readonly variant = computed(() => {
    const s = this.store.selection();
    return s.kind === 'variant'
      ? (this.store.config()?.variants.find((v) => v.id === s.id) ?? null)
      : null;
  });
  protected readonly repoLabel = computed(() => this.store.storageLabel());
  protected readonly publishedAgo = computed(() => {
    const at = this.store.record()?.publishedAt;
    return at ? relativeTime(at, Date.now()) : '';
  });

  protected setName(name: string): void {
    if (name) this.store.edit((c) => edit.patchProduct(c, { name }), 'product-name');
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

  protected async removeVariant(id: string): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: 'Delete this variant?',
      message: 'Customers will no longer see it. Mockups and areas are kept. You can undo this.',
      confirmLabel: 'Delete variant',
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeVariant(c, id));
    this.store.select({ kind: 'product' });
  }
}
