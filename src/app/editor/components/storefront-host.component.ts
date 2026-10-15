import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Customization, SaveResult } from '../../customizer/models';
import {
  CustomizerChangeDetail,
  CustomizerErrorDetail,
  CustomizerReadyDetail,
  CustomizerSaveDetail,
} from '../../customizer/models/events.models';
import { ProductCustomizerComponent } from '../../customizer/product-customizer.component';
import { dbGet, dbPut } from '../../customizer/services/local-db';
import { downloadBlob, safeFilename } from '../util/download';

type HostMode = 'success' | 'error' | 'silent';

interface StoredDraft {
  id: string;
  customization: Customization;
  assets: CustomizerSaveDetail['assets'];
  savedAt: number;
}

/**
 * The customer storefront around `<app-product-customizer>`. It plays the host application: it
 * receives `customizer-save`, keeps the payload in memory (and the last one in IndexedDB so it can be
 * reopened after a reload), acknowledges with `saveResult` and offers the exports for download.
 */
@Component({
  selector: 'app-storefront-host',
  imports: [ProductCustomizerComponent],
  template: `
    <div class="host-layout">
      <section class="host-panel" aria-labelledby="host-title">
        <h2 id="host-title" class="ed-title">Storefront host</h2>
        <p class="ed-hint">
          The customer form below is generated from the artwork configuration. Nothing is sent to a
          server.
        </p>

        <label class="ed-field">
          <span class="ed-label">Simulated host response to Save</span>
          <select class="ed-input" (change)="hostMode.set($any($event.target).value)">
            <option value="success" [selected]="hostMode() === 'success'">
              Succeeds after 0.6 s
            </option>
            <option value="error" [selected]="hostMode() === 'error'">Fails after 0.6 s</option>
            <option value="silent" [selected]="hostMode() === 'silent'">
              Never answers (retry after 30 s)
            </option>
          </select>
        </label>

        <h3 class="ed-subtitle">Saved design</h3>
        @if (lastSave(); as saved) {
          <p class="ed-hint">
            {{ saved.artworks.length }} printable area artwork(s),
            {{ saved.previews.length }} preview(s), {{ saved.assets.length }} uploaded image(s).
          </p>
          <h4 class="ed-label">Production artwork (one per printable area)</h4>
          <ul class="ed-list">
            @for (art of saved.artworks; track art.printableAreaId) {
              <li class="ed-list-row">
                <button type="button" class="ed-btn" (click)="downloadArea(art)">
                  {{ art.printableAreaName }} PNG
                </button>
                <span class="ed-hint">{{ art.width }}×{{ art.height }} px</span>
              </li>
            }
          </ul>
          <h4 class="ed-label">Product preview</h4>
          <ul class="ed-list">
            @for (preview of saved.previews; track preview.mockupId) {
              <li class="ed-list-row">
                <button type="button" class="ed-btn" (click)="downloadPreview(preview)">
                  {{ preview.mockupName }} PNG
                </button>
              </li>
            }
          </ul>
          <div class="ed-row">
            <button type="button" class="ed-btn" (click)="downloadAll()">Download all PNGs</button>
            <button type="button" class="ed-btn" (click)="downloadJson()">Download JSON</button>
            <button
              type="button"
              class="ed-btn"
              (click)="restore(saved.customization, saved.assets)"
            >
              Reopen this design
            </button>
          </div>
        } @else if (stored(); as old) {
          <p class="ed-hint">A design was saved here on {{ savedDate(old.savedAt) }}.</p>
          <button type="button" class="ed-btn" (click)="restore(old.customization, old.assets)">
            Reopen last saved design
          </button>
        } @else {
          <p class="ed-hint">Nothing saved yet. Customize the product and choose Save.</p>
        }

        <h3 class="ed-subtitle">Event log</h3>
        <ol class="ed-log" aria-live="off">
          @for (line of log(); track line) {
            <li>{{ line }}</li>
          }
        </ol>
      </section>

      <section class="host-widget" aria-label="Customizer">
        <app-product-customizer
          [config]="config()"
          [configUrl]="configUrl()"
          [allowLocalAssets]="true"
          [saveResult]="saveResult()"
          [initialCustomization]="initialCustomization()"
          [assetMap]="assetMap()"
          (customizer-ready)="onReady($event)"
          (customizer-change)="onChange($event)"
          (customizer-save)="onSave($event)"
          (customizer-error)="onError($event)"
        />
      </section>
    </div>
  `,
})
export class StorefrontHostComponent {
  /** Configuration object (preferred) or a URL; the storage id keys the persisted last design. */
  readonly config = input<unknown>(null);
  readonly configUrl = input<string | null>(null);
  readonly storageId = input<string | null>(null);

  protected readonly hostMode = signal<HostMode>('success');
  protected readonly saveResult = signal<SaveResult | null>(null);
  protected readonly initialCustomization = signal<Customization | null>(null);
  protected readonly assetMap = signal<ReadonlyMap<string, Blob> | null>(null);
  protected readonly lastSave = signal<CustomizerSaveDetail | null>(null);
  protected readonly stored = signal<StoredDraft | null>(null);
  protected readonly log = signal<readonly string[]>([]);
  private logCount = 0;
  private readonly prepared = new Map<string, CustomizerSaveDetail>();

  protected readonly savedDate = (time: number) => new Date(time).toLocaleString();

  constructor() {
    effect(() => {
      const id = this.storageId();
      if (id)
        void dbGet<StoredDraft>('drafts', id)
          .then((draft) => this.stored.set(draft ?? null))
          .catch(() => undefined);
    });
  }

  protected onReady(detail: CustomizerReadyDetail): void {
    this.addLog(
      `ready: ${detail.templateId} v${detail.templateVersion} (schema ${detail.schemaVersion ?? 1})`,
    );
  }

  protected onChange(detail: CustomizerChangeDetail): void {
    this.addLog(
      `change: valid=${detail.valid} dirty=${detail.dirty} errors=${detail.errors.length}`,
    );
  }

  protected onError(detail: CustomizerErrorDetail): void {
    this.addLog(`error: ${detail.code} - ${detail.message}`);
  }

  protected onSave(detail: CustomizerSaveDetail): void {
    const duplicate = this.prepared.has(detail.requestId);
    this.addLog(
      `save: request ${detail.requestId.slice(0, 8)}${duplicate ? ' (retry; de-duplicated)' : ''} - ${detail.artworks.length} area artwork(s)`,
    );
    if (!duplicate) this.prepared.set(detail.requestId, detail);
    const mode = this.hostMode();
    if (mode === 'silent') return;
    setTimeout(() => {
      if (mode === 'success') {
        this.lastSave.set(detail);
        this.persist(detail);
        this.saveResult.set({
          requestId: detail.requestId,
          status: 'success',
          message: 'Prepared in demo. Nothing was sent to a server; use the downloads on the left.',
        });
      } else {
        this.saveResult.set({
          requestId: detail.requestId,
          status: 'error',
          message: 'The demo host rejected this save.',
        });
      }
    }, 600);
  }

  private persist(detail: CustomizerSaveDetail): void {
    const id = this.storageId();
    if (!id) return;
    void dbPut<StoredDraft>('drafts', {
      id,
      customization: detail.customization,
      assets: detail.assets,
      savedAt: Date.now(),
    }).catch(() => undefined);
  }

  protected restore(customization: Customization, assets: CustomizerSaveDetail['assets']): void {
    this.assetMap.set(new Map(assets.map((a) => [a.assetId, a.blob])));
    this.initialCustomization.set(customization);
  }

  protected downloadArea(art: CustomizerSaveDetail['artworks'][number]): void {
    downloadBlob(
      art.blob,
      `${safeFilename(art.printableAreaId)}-artwork-${art.width}x${art.height}.png`,
    );
  }

  protected downloadPreview(preview: CustomizerSaveDetail['previews'][number]): void {
    downloadBlob(preview.blob, `${safeFilename(preview.mockupId)}-preview.png`);
  }

  protected downloadAll(): void {
    const saved = this.lastSave();
    if (!saved) return;
    saved.artworks.forEach((a) => this.downloadArea(a));
    saved.previews.forEach((p) => this.downloadPreview(p));
  }

  protected downloadJson(): void {
    const saved = this.lastSave();
    if (!saved) return;
    downloadBlob(
      new Blob([JSON.stringify(saved.customization, null, 2)], { type: 'application/json' }),
      'customization.json',
    );
  }

  private addLog(line: string): void {
    this.logCount++;
    this.log.update((lines) => [`${this.logCount}. ${line}`, ...lines].slice(0, 40));
  }

  readonly hasSave = computed(() => this.lastSave() !== null);
}
