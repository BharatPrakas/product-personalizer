import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '../admin/i18n/i18n.service';
import { IconComponent } from '../ui/icon.component';
import { OrderDownloads } from './order-downloads';

/**
 * Progress and outcome of the current archive download. The live region announces progress and the
 * result; failures are listed per file with "Retry failed files" (fetches only those) and
 * "Save without them".
 */
@Component({
  selector: 'app-download-status',
  imports: [IconComponent, TranslatePipe],
  template: `
    <div class="download-status" [class.is-hidden]="!job()">
      <p class="download-status__line" role="status" aria-live="polite">
        @if (job(); as j) {
          @switch (j.state) {
            @case ('running') {
              {{ 'orders.download.progress' | t: { name: j.filename, done: j.done, total: j.total } }}
            }
            @case ('saved') {
              {{ (j.failures.length ? 'orders.download.saved-partial' : 'orders.download.saved') | t: { name: j.filename, count: j.failures.length } }}
            }
            @case ('partial') {
              {{ 'orders.download.partial' | t: { name: j.filename, count: j.failures.length } }}
            }
            @case ('cancelled') {
              {{ 'orders.download.cancelled' | t }}
            }
          }
        }
      </p>
      @if (job(); as j) {
        @if (j.state === 'running') {
          <progress class="download-status__bar" [max]="j.total" [value]="j.done" [attr.aria-label]="'orders.download.progress-label' | t"></progress>
        }
        @if (j.failures.length && j.state !== 'running') {
          <ul class="plain-list download-status__failures">
            @for (f of j.failures; track f.path) {
              <li>
                <app-icon name="alert" [size]="14" />
                <span class="mono">{{ f.path }}</span>
                — {{ (f.reason === 'missing' ? 'orders.file.unavailable' : 'orders.file.error') | t }}
              </li>
            }
          </ul>
        }
        <div class="row row--tight">
          @if (j.state === 'running') {
            <button type="button" class="btn btn--sm" (click)="downloads.cancel()">{{ 'common.cancel' | t }}</button>
          } @else {
            @if (downloads.retryable()) {
              <button type="button" class="btn btn--sm btn--primary" (click)="downloads.retry()">{{ 'orders.download.retry' | t }}</button>
            }
            @if (j.state === 'partial') {
              <button type="button" class="btn btn--sm" (click)="downloads.saveAnyway()">{{ 'orders.download.save-anyway' | t }}</button>
            }
            <button type="button" class="btn btn--sm btn--ghost" (click)="downloads.dismiss()">{{ 'common.dismiss' | t }}</button>
          }
        </div>
      }
    </div>
  `,
})
export class DownloadStatusComponent {
  protected readonly downloads = inject(OrderDownloads);
  protected readonly job = computed(() => this.downloads.job());
}
