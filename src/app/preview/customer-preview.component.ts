import { I18n, TranslatePipe } from '../admin/i18n/i18n.service';
import { Component, computed, input, output, signal } from '@angular/core';
import { ProductConfig } from '../customizer/models/product.models';
import {
  CustomizerErrorDetail,
  CustomizerSaveDetail,
  SaveResult,
} from '../customizer/models/events.models';
import { ProductCustomizerComponent } from '../customizer/product-customizer.component';
import { downloadBlob, safeFilename } from '../editor/util/download';
import { IconComponent } from '../ui/icon.component';
import { MenuComponent } from '../ui/menu.component';
import { ToastService } from '../ui/toast.service';
import { inject } from '@angular/core';

type Device = 'desktop' | 'mobile';

/**
 * The customer's view of a configuration and nothing else: gallery, variants, the generated inputs
 * and the live preview. The merchant-only chrome around it is a slim bar; the personalization UI is
 * the same `<app-product-customizer>` the custom element ships.
 *
 * There is no cart or checkout here. "Save customization" only checks the design and produces the
 * production files, which the merchant can download from the bar to inspect them.
 */
@Component({
  selector: 'app-customer-preview',
  imports: [ProductCustomizerComponent, IconComponent, MenuComponent, TranslatePipe],
  template: `
    <header class="preview-bar">
      <button type="button" class="btn" (click)="back.emit()">
        <app-icon name="arrow-left" [size]="16" /> {{ backLabel() ?? ('editor.preview.back' | t) }}
      </button>
      <div class="preview-bar__title">
        <strong class="truncate">{{ config().product.name }}</strong>
        <span class="badge badge--info">{{ 'preview.customer' | t }}</span>
        <span class="subtle small truncate">{{ sourceLabel() }}</span>
      </div>
      <span class="grow"></span>
      <div class="segmented" role="group" [attr.aria-label]="'preview.width' | t">
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="device() === 'desktop'"
          (click)="device.set('desktop')"
        >
          {{ 'preview.desktop' | t }}
        </button>
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="device() === 'mobile'"
          (click)="device.set('mobile')"
        >
          {{ 'preview.mobile' | t }}
        </button>
      </div>
      <app-menu
        [label]="'preview.test-files' | t"
        [text]="'preview.test-files' | t"
        align="end"
        [disabled]="!lastSave()"
      >
        @if (lastSave(); as saved) {
          <div class="menu-label">{{ 'preview.menu.art' | t }}</div>
          @for (art of saved.artworks; track art.printableAreaId) {
            <button type="button" class="menu-item" role="menuitem" (click)="downloadArea(art)">
              <app-icon name="download" [size]="16" />
              <span
                >{{ art.printableAreaName
                }}<small>{{
                  'preview.png-size' | t: { width: art.width, height: art.height }
                }}</small></span
              >
            </button>
          }
          <div class="menu-sep"></div>
          <div class="menu-label">{{ 'preview.menu.previews' | t }}</div>
          @for (preview of saved.previews; track preview.mockupId) {
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              (click)="downloadPreview(preview)"
            >
              <app-icon name="download" [size]="16" /> {{ preview.mockupName }}
            </button>
          }
          <div class="menu-sep"></div>
          <button type="button" class="menu-item" role="menuitem" (click)="downloadAll()">
            <app-icon name="download" [size]="16" /> {{ 'preview.download-all' | t }}
          </button>
        }
      </app-menu>
    </header>
    <div class="preview-stage">
      <div class="preview-frame" [class.preview-frame--mobile]="device() === 'mobile'">
        <app-product-customizer
          [config]="config()"
          [allowLocalAssets]="true"
          [saveResult]="saveResult()"
          (customizer-save)="onSave($event)"
          (customizer-error)="onError($event)"
        />
      </div>
      @if (!lastSave()) {
        <p class="subtle small preview-note">
          {{ 'preview.note' | t }}
        </p>
      }
    </div>
  `,
})
export class CustomerPreviewComponent {
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(I18n);

  readonly config = input.required<ProductConfig>();
  readonly sourceLabel = input('');
  /** Defaults to "Back to editor". */
  readonly backLabel = input<string | null>(null);
  readonly back = output<void>();

  protected readonly device = signal<Device>('desktop');
  protected readonly saveResult = signal<SaveResult | null>(null);
  protected readonly lastSave = signal<CustomizerSaveDetail | null>(null);

  protected readonly hasFiles = computed(() => this.lastSave() !== null);

  protected onSave(detail: CustomizerSaveDetail): void {
    this.lastSave.set(detail);
    // Honest acknowledgement: the design was checked and the files were generated, nothing more.
    this.saveResult.set({
      requestId: detail.requestId,
      status: 'success',
      message: this.i18n.t('preview.saved-message'),
    });
    this.toasts.success(this.i18n.t('preview.toast.checked'));
  }

  protected onError(detail: CustomizerErrorDetail): void {
    if (!detail.recoverable) this.toasts.error(detail.message);
  }

  protected downloadArea(art: CustomizerSaveDetail['artworks'][number]): void {
    downloadBlob(art.blob, `${safeFilename(art.printableAreaName)}-${art.width}x${art.height}.png`);
  }

  protected downloadPreview(preview: CustomizerSaveDetail['previews'][number]): void {
    downloadBlob(preview.blob, `${safeFilename(preview.mockupName)}-preview.png`);
  }

  protected downloadAll(): void {
    const saved = this.lastSave();
    if (!saved) return;
    saved.artworks.forEach((a) => this.downloadArea(a));
    saved.previews.forEach((p) => this.downloadPreview(p));
  }
}
