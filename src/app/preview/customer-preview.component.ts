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
  imports: [ProductCustomizerComponent, IconComponent, MenuComponent],
  template: `
    <header class="preview-bar">
      <button type="button" class="btn" (click)="back.emit()">
        <app-icon name="arrow-left" [size]="16" /> {{ backLabel() }}
      </button>
      <div class="preview-bar__title">
        <strong class="truncate">{{ config().product.name }}</strong>
        <span class="badge badge--info">Customer preview</span>
        <span class="subtle small truncate">{{ sourceLabel() }}</span>
      </div>
      <span class="grow"></span>
      <div class="segmented" role="group" aria-label="Preview width">
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="device() === 'desktop'"
          (click)="device.set('desktop')"
        >
          Desktop
        </button>
        <button
          type="button"
          class="segmented-item"
          [attr.aria-pressed]="device() === 'mobile'"
          (click)="device.set('mobile')"
        >
          Mobile
        </button>
      </div>
      <app-menu label="Test files" text="Test files" align="end" [disabled]="!lastSave()">
        @if (lastSave(); as saved) {
          <div class="menu-label">Production artwork, one per printable area</div>
          @for (art of saved.artworks; track art.printableAreaId) {
            <button type="button" class="menu-item" role="menuitem" (click)="downloadArea(art)">
              <app-icon name="download" [size]="16" />
              <span
                >{{ art.printableAreaName
                }}<small>{{ art.width }} × {{ art.height }} px PNG</small></span
              >
            </button>
          }
          <div class="menu-sep"></div>
          <div class="menu-label">Product previews</div>
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
            <app-icon name="download" [size]="16" /> Download everything
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
          Choose “Save customization” in the form to check the design and enable the test files
          above. Nothing is stored or sent.
        </p>
      }
    </div>
  `,
})
export class CustomerPreviewComponent {
  private readonly toasts = inject(ToastService);

  readonly config = input.required<ProductConfig>();
  readonly sourceLabel = input('');
  readonly backLabel = input('Back to editor');
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
      message:
        'Design checked. Nothing was stored; use Test files to download the production artwork.',
    });
    this.toasts.success('Design checked. Test files are ready to download.');
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
