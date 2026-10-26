import { Component, computed, inject } from '@angular/core';
import { I18n, TranslatePipe } from '../../admin/i18n/i18n.service';
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
  imports: [CONTROLS, SectionComponent, IconComponent, TranslatePipe],
  template: `
    @if (store.config(); as c) {
      @if (variant(); as v) {
        <header class="inspector-head">
          <p class="inspector-kind">{{ 'inspector.variant' | t }}</p>
          <app-text-in
            [label]="'inspector.name' | t"
            [value]="v.label"
            [maxlength]="60"
            (changed)="setLabel($event)"
          />
        </header>
        <app-section [title]="'inspector.appearance' | t">
          <app-color
            [label]="'inspector.swatch' | t"
            [allowTransparent]="true"
            [value]="v.swatch ?? 'transparent'"
            (changed)="setSwatch($event)"
          />
        </app-section>
        <app-section [title]="'inspector.variant.mockups' | t">
          @if (c.mockups.length === 0) {
            <p class="field-hint">{{ 'inspector.variant.add-mockup-first' | t }}</p>
          }
          @for (m of c.mockups; track m.id) {
            <app-check
              [label]="m.name"
              [value]="v.mockupIds.includes(m.id)"
              (changed)="toggleMockup(m.id, $event)"
            />
          }
        </app-section>
        <app-section [title]="'inspector.variant.areas' | t">
          @if (c.printableAreas.length === 0) {
            <p class="field-hint">{{ 'inspector.variant.add-area-first' | t }}</p>
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
            {{ 'inspector.back-to-config' | t }}
          </button>
          <button
            type="button"
            class="btn btn--sm btn--danger"
            [disabled]="c.variants.length <= 1"
            (click)="removeVariant(v.id)"
          >
            {{ 'inspector.variant.delete' | t }}
          </button>
        </div>
      } @else {
        <header class="inspector-head">
          <p class="inspector-kind">{{ 'inspector.config' | t }}</p>
          <app-text-in
            [label]="'inspector.name' | t"
            [value]="c.product.name"
            [maxlength]="120"
            (changed)="setName($event)"
          />
        </header>

        <app-section [title]="(store.publishable() ? 'inspector.ready' : 'inspector.setup') | t">
          <ol class="steps">
            @for (step of store.steps(); track step.id) {
              <li class="step" [class.is-done]="step.done">
                <app-icon [name]="step.done ? 'circle-check' : 'circle-empty'" [size]="18" />
                <span class="step-text">
                  <span class="step-label">{{ step.labelKey | t }}</span>
                  @if (!step.done) {
                    <span class="step-hint">{{ step.hintKey | t }}</span>
                  }
                </span>
              </li>
            }
          </ol>
          @if (store.issues().length > 0) {
            <ul class="issue-list" [attr.aria-label]="'inspector.problems' | t">
              @for (issue of store.issues().slice(0, 6); track $index) {
                <li>{{ issue.message }}</li>
              }
            </ul>
          }
        </app-section>

        <app-section [title]="'inspector.publishing' | t">
          @if (store.published() && store.record(); as record) {
            <p class="field-hint">
              {{
                (store.unpublishedChanges()
                  ? 'inspector.published.changed'
                  : 'inspector.published.same'
                ) | t: { when: publishedAgo() }
              }}
            </p>
          } @else {
            <p class="field-hint">
              {{ 'inspector.not-published' | t }}
            </p>
          }
          <p class="field-hint">{{ repoLabel() }}</p>
        </app-section>

        <app-section [title]="'inspector.variants' | t">
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
                <span class="field-hint">{{
                  'inspector.variant.counts'
                    | t: { mockups: v.mockupIds.length, areas: v.printableAreaIds.length }
                }}</span>
              </li>
            }
          </ul>
          <button type="button" class="btn btn--sm" (click)="addVariant()">
            {{ 'inspector.variant.add' | t }}
          </button>
        </app-section>

        <app-section [title]="'inspector.editor-view' | t" [open]="false">
          <app-check
            [label]="'inspector.show-boundaries' | t"
            [value]="store.showBoundaries()"
            (changed)="store.showBoundaries.set($event)"
          />
          <app-check
            [label]="'inspector.sample-photos' | t"
            [value]="store.sampleContent()"
            (changed)="store.setSampleContent($event)"
          />
          <p class="field-hint">
            {{ 'inspector.editor-view-note' | t }}
          </p>
        </app-section>

        <app-section [title]="'inspector.technical' | t" [open]="false">
          <dl class="facts">
            <dt>{{ 'inspector.config-id' | t }}</dt>
            <dd>
              <code>{{ c.id }}</code>
            </dd>
            <dt>{{ 'inspector.draft-version' | t }}</dt>
            <dd>{{ c.version }}</dd>
            <dt>{{ 'inspector.schema' | t }}</dt>
            <dd>{{ 'inspector.schema-version' | t: { version: c.schemaVersion } }}</dd>
          </dl>
        </app-section>
      }
    }
  `,
})
export class ConfigurationInspectorComponent {
  protected readonly store = inject(EditorStore);
  private readonly confirmService = inject(ConfirmService);
  private readonly i18n = inject(I18n);

  protected readonly variant = computed(() => {
    const s = this.store.selection();
    return s.kind === 'variant'
      ? (this.store.config()?.variants.find((v) => v.id === s.id) ?? null)
      : null;
  });
  protected readonly repoLabel = computed(() => this.store.storageLabel());
  protected readonly publishedAgo = computed(() => {
    const at = this.store.record()?.publishedAt;
    return at ? relativeTime(at, Date.now(), this.i18n) : '';
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
      title: this.i18n.t('inspector.variant.delete.title'),
      message: this.i18n.t('inspector.variant.delete.message'),
      confirmLabel: this.i18n.t('inspector.variant.delete.confirm'),
      danger: true,
    });
    if (!ok) return;
    this.store.edit((c) => edit.removeVariant(c, id));
    this.store.select({ kind: 'product' });
  }
}
