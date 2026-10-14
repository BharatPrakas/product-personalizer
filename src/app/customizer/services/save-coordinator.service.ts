import { Service, computed, signal } from '@angular/core';
import { CustomizerSaveDetail, SaveResult } from '../models/events.models';
import { CustomizerError } from './errors';
import { uuid } from '../util/ids';
import type { SavePayload } from './export.service';

/** How long to wait for the host before offering a retry. */
export const ACK_TIMEOUT_MS = 30_000;

export type SaveState =
  | 'idle'
  | 'exporting'
  | 'awaiting-host'
  /** 30 s passed without an acknowledgement; Retry re-sends the same request. */
  | 'no-response'
  | 'saved'
  | 'host-error'
  | 'export-error';

/**
 * What the host receives. The JSON parts are copied for every emission (the Blobs are shared, they are
 * immutable), so a host that mutates the event it got cannot alter the pending request: a retry still
 * carries exactly the payload of the original.
 */
function handOver(detail: CustomizerSaveDetail): CustomizerSaveDetail {
  return {
    ...detail,
    customization: structuredClone(detail.customization),
    assets: detail.assets.map((asset) => ({ ...asset })),
  };
}

interface PendingSave {
  detail: CustomizerSaveDetail;
  /** Draft values at freeze time, to mark as the saved baseline on success. */
  valuesKey: string;
}

/**
 * The save protocol, independent of any UI:
 *  1. `start` freezes the draft, builds the payload, assigns a request id and emits once.
 *  2. While `exporting` / `awaiting-host` / `no-response` the form is locked.
 *  3. `acknowledge` honours only a result whose request id matches the pending request.
 *  4. After 30 s without an answer, `retry` re-emits the identical request (same id, same payload).
 */
@Service({ autoProvided: false })
export class SaveCoordinator {
  readonly state = signal<SaveState>('idle');
  readonly message = signal<string | null>(null);
  readonly locked = computed(() =>
    ['exporting', 'awaiting-host', 'no-response'].includes(this.state()),
  );
  readonly canStart = computed(() =>
    ['idle', 'saved', 'host-error', 'export-error'].includes(this.state()),
  );

  private pending: PendingSave | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by `cancel` so a late export from a superseded draft/config is discarded. */
  private epoch = 0;

  get pendingRequestId(): string | null {
    return this.pending?.detail.requestId ?? null;
  }

  /**
   * `shouldEmit` is asked again once the export has finished: if the host disabled the element in the
   * meantime the request is dropped (back to idle) instead of being sent.
   */
  async start(
    produce: () => Promise<SavePayload>,
    emit: (detail: CustomizerSaveDetail) => void,
    valuesKey: string,
    shouldEmit: () => boolean = () => true,
  ): Promise<void> {
    if (!this.canStart()) return;
    const epoch = ++this.epoch;
    this.state.set('exporting');
    this.message.set(null);
    let payload: SavePayload;
    try {
      payload = await produce();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.state.set('export-error');
      this.message.set(
        error instanceof CustomizerError
          ? error.message
          : 'The design could not be exported. Please try again.',
      );
      throw error;
    }
    if (epoch !== this.epoch) return;
    if (!shouldEmit()) {
      this.state.set('idle');
      this.message.set(null);
      return;
    }
    this.pending = { detail: { requestId: uuid(), ...payload }, valuesKey };
    this.state.set('awaiting-host');
    this.armTimer();
    emit(handOver(this.pending.detail));
  }

  /** Re-send the same request after a timeout. */
  retry(emit: (detail: CustomizerSaveDetail) => void): boolean {
    if (this.state() !== 'no-response' || !this.pending) return false;
    this.state.set('awaiting-host');
    this.armTimer();
    emit(handOver(this.pending.detail));
    return true;
  }

  /**
   * Apply the host's result. Returns the saved draft key on success, `null` otherwise.
   * Results for any other request id (stale, duplicate, unknown) are ignored.
   */
  acknowledge(result: SaveResult): { applied: boolean; savedKey?: string } {
    const pending = this.pending;
    if (!pending || result.requestId !== pending.detail.requestId) return { applied: false };
    this.clearTimer();
    this.pending = null;
    if (result.status === 'success') {
      this.state.set('saved');
      this.message.set(result.message?.trim() || 'Customization saved.');
      return { applied: true, savedKey: pending.valuesKey };
    }
    this.state.set('host-error');
    this.message.set(
      result.message?.trim() ||
        'The host could not save this customization. Your changes are kept; please try again.',
    );
    return { applied: true };
  }

  /** The shopper changed something after a result: clear the stale status line. */
  noteEdit(): void {
    if (['saved', 'host-error', 'export-error'].includes(this.state())) {
      this.state.set('idle');
      this.message.set(null);
    }
  }

  /** Drop any pending request (new configuration, reset, teardown). Late acknowledgements are then stale. */
  cancel(): void {
    this.epoch++;
    this.clearTimer();
    this.pending = null;
    this.state.set('idle');
    this.message.set(null);
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state() === 'awaiting-host') this.state.set('no-response');
    }, ACK_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
