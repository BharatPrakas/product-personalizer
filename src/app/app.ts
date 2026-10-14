import { Component, signal } from '@angular/core';
import { ProductCustomizerComponent } from './customizer/product-customizer.component';
import { Customization, SaveResult } from './customizer/models';
import {
  CustomizerChangeDetail,
  CustomizerErrorDetail,
  CustomizerReadyDetail,
  CustomizerSaveDetail,
} from './customizer/models/events.models';

interface Sample {
  id: string;
  label: string;
  url: string;
}

type HostMode = 'success' | 'error' | 'silent';

const SAMPLES: readonly Sample[] = [
  { id: 'tshirt', label: 'T-shirt: text only', url: 'data/tshirt-text.json' },
  { id: 'tote', label: 'Tote: name + photo', url: 'data/tote-photo.json' },
  { id: 'poster', label: 'Poster: text + artwork', url: 'data/poster-artwork.json' },
];

/**
 * Demo host for the customizer, using the component directly (the plain-HTML demo in
 * `integration-demo/` uses the registered custom element instead).
 *
 * It stands in for the host application: it receives `customizer-save`, keeps the payload in
 * memory only (nothing is sent anywhere) and acknowledges with `saveResult`.
 */
@Component({
  selector: 'app-root',
  imports: [ProductCustomizerComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly samples = SAMPLES;
  protected readonly selected = signal<Sample>(SAMPLES[1]);
  protected readonly hostMode = signal<HostMode>('success');
  protected readonly hostDisabled = signal(false);
  protected readonly saveResult = signal<SaveResult | null>(null);
  protected readonly initialCustomization = signal<Customization | null>(null);
  protected readonly assetMap = signal<ReadonlyMap<string, Blob> | null>(null);
  protected readonly lastSave = signal<CustomizerSaveDetail | null>(null);
  protected readonly dirty = signal(false);
  protected readonly log = signal<readonly string[]>([]);

  /** requestId -> payload, standing in for a host that de-duplicates on request id. */
  private readonly prepared = new Map<string, CustomizerSaveDetail>();
  private logCount = 0;

  protected select(sample: Sample): void {
    // A real host would confirm unsaved changes (see `dirty`) before swapping the configuration.
    if (this.dirty() && !confirm('Discard unsaved changes and switch product?')) return;
    this.selected.set(sample);
    this.initialCustomization.set(null);
    this.assetMap.set(null);
    this.saveResult.set(null);
    this.dirty.set(false);
  }

  protected onReady(detail: CustomizerReadyDetail): void {
    this.addLog(`ready: ${detail.templateId} v${detail.templateVersion}`);
  }

  protected onChange(detail: CustomizerChangeDetail): void {
    this.dirty.set(detail.dirty);
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
      `save: request ${detail.requestId.slice(0, 8)}${duplicate ? ' (retry; de-duplicated by request id)' : ''}`,
    );
    if (!duplicate) this.prepared.set(detail.requestId, detail);

    const mode = this.hostMode();
    if (mode === 'silent') return; // never answer: the element shows "No response yet" after 30 s
    setTimeout(() => {
      if (mode === 'success') {
        this.lastSave.set(detail);
        this.saveResult.set({
          requestId: detail.requestId,
          status: 'success',
          message: 'Prepared in demo. Nothing was sent to a server; download the files below.',
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

  protected restore(): void {
    const saved = this.lastSave();
    if (!saved) return;
    this.assetMap.set(new Map(saved.assets.map((asset) => [asset.assetId, asset.blob])));
    this.initialCustomization.set(saved.customization);
  }

  protected download(kind: 'json' | 'artwork' | 'preview'): void {
    const saved = this.lastSave();
    if (!saved) return;
    if (kind === 'json') {
      const json = JSON.stringify(saved.customization, null, 2);
      this.saveFile('customization.json', new Blob([json], { type: 'application/json' }));
    } else if (kind === 'artwork') {
      this.saveFile('artwork.png', saved.artworkBlob);
    } else {
      this.saveFile('preview.png', saved.previewBlob);
    }
  }

  private saveFile(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private addLog(line: string): void {
    this.logCount++;
    this.log.update((lines) => [`${this.logCount}. ${line}`, ...lines].slice(0, 40));
  }

  protected setHostMode(event: Event): void {
    this.hostMode.set((event.target as HTMLSelectElement).value as HostMode);
  }
}
