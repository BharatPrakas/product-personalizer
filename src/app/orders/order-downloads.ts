import { Injectable, computed, inject, signal } from '@angular/core';
import { downloadBlob } from '../editor/util/download';
import type { ArchiveEntry, ArchivePlan } from './order-archive';
import { OrderFileMissingError } from './order.models';
import { OrderRepository } from './order-repository';
import { createZip } from './zip';

export interface DownloadFailure {
  path: string;
  label: string;
  /** `missing`: the file is gone and cannot be retried. */
  reason: 'missing' | 'error';
}

export interface DownloadJob {
  filename: string;
  total: number;
  done: number;
  failures: DownloadFailure[];
  state: 'running' | 'saved' | 'partial' | 'cancelled';
}

const CONCURRENCY = 3;

/**
 * One archive download at a time for the order detail page: fetches every planned file through the
 * authenticated API (never a token in a URL), reports progress and per-file failures, keeps the bytes
 * that did arrive so "Retry failed files" fetches only the rest, and packs the ZIP client-side.
 * Provided by the detail component, so it is released with it.
 */
@Injectable()
export class OrderDownloads {
  private readonly orders = inject(OrderRepository);

  readonly job = signal<DownloadJob | null>(null);
  readonly busy = computed(() => this.job()?.state === 'running');
  readonly retryable = computed(() => this.job()?.failures.some((f) => f.reason === 'error') ?? false);

  private plan: ArchivePlan | null = null;
  private readonly fetched = new Map<string, Uint8Array>();
  private abort: AbortController | null = null;

  /** Starts a new archive; any previous one is abandoned. */
  start(plan: ArchivePlan): Promise<void> {
    this.cancel();
    this.plan = plan;
    this.fetched.clear();
    return this.fetchMissing();
  }

  /** Fetches again only the files that failed with a (possibly transient) error. */
  retry(): Promise<void> {
    return this.plan ? this.fetchMissing() : Promise.resolve();
  }

  /** Saves the archive without the files that could not be fetched. */
  saveAnyway(): void {
    if (this.plan) this.save(this.plan);
  }

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
    const job = this.job();
    if (job?.state === 'running') this.job.set({ ...job, state: 'cancelled' });
  }

  dismiss(): void {
    this.cancel();
    this.job.set(null);
    this.plan = null;
    this.fetched.clear();
  }

  private async fetchMissing(): Promise<void> {
    const plan = this.plan!;
    const controller = new AbortController();
    this.abort = controller;
    const pending = plan.entries.filter((e) => !this.fetched.has(e.path));
    const missing: DownloadFailure[] = plan.missing.map((m) => ({ ...m, reason: 'missing' }));
    const failures: DownloadFailure[] = [];
    this.job.set({
      filename: plan.filename,
      total: plan.entries.length + plan.missing.length,
      done: this.fetched.size,
      failures: missing,
      state: 'running',
    });

    const queue = [...pending];
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        if (controller.signal.aborted) return;
        try {
          this.fetched.set(entry.path, await this.bytesOf(entry, controller.signal));
        } catch (error) {
          if (controller.signal.aborted) return;
          failures.push({
            path: entry.path,
            label: entry.label,
            reason: error instanceof OrderFileMissingError ? 'missing' : 'error',
          });
        }
        this.job.update((j) => j && { ...j, done: this.fetched.size, failures: [...missing, ...failures] });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (controller.signal.aborted || this.plan !== plan) return;
    this.abort = null;

    const all = [...missing, ...failures];
    if (all.length === 0) {
      this.save(plan);
    } else {
      this.job.update((j) => j && { ...j, failures: all, state: 'partial' });
    }
  }

  private async bytesOf(entry: ArchiveEntry, signal: AbortSignal): Promise<Uint8Array> {
    if (entry.source.kind === 'json') {
      return new TextEncoder().encode(JSON.stringify(entry.source.value, null, 2));
    }
    const blob = await this.orders.file(entry.source.customizationId, entry.source.assetId, signal);
    return new Uint8Array(await blob.arrayBuffer());
  }

  private save(plan: ArchivePlan): void {
    const entries = plan.entries
      .filter((e) => this.fetched.has(e.path))
      .map((e) => ({ path: e.path, data: this.fetched.get(e.path)! }));
    downloadBlob(createZip(entries), plan.filename);
    // `failures` stays on a saved job, so the page can say which files were left out (and retry them).
    this.job.update((j) => j && { ...j, done: entries.length, state: 'saved' });
    if (this.job()?.failures.length === 0) this.fetched.clear();
  }
}
