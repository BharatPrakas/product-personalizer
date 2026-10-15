import { TestBed } from '@angular/core/testing';
import { CustomizerSaveDetail } from '../models/events.models';
import { SavePayload } from './export.service';
import { ACK_TIMEOUT_MS, SaveCoordinator } from './save-coordinator.service';

const payload = (): SavePayload => ({
  customization: { values: {} } as SavePayload['customization'],
  previewBlob: new Blob(['p']),
  artworks: [],
  previews: [],
  artworkBlob: new Blob(['a']),
  assets: [],
});

describe('SaveCoordinator (F12, F13)', () => {
  let save: SaveCoordinator;
  let events: CustomizerSaveDetail[];
  const emit = (detail: CustomizerSaveDetail) => void events.push(detail);

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [SaveCoordinator] });
    save = TestBed.inject(SaveCoordinator);
    events = [];
  });

  afterEach(() => {
    save.cancel();
    vi.useRealTimers();
  });

  it('locks the form while exporting, then emits exactly one request and waits for the host', async () => {
    let release!: (p: SavePayload) => void;
    const started = save.start(
      () => new Promise<SavePayload>((resolve) => (release = resolve)),
      emit,
      'key-1',
    );
    expect(save.state()).toBe('exporting');
    expect(save.locked()).toBe(true);
    expect(save.canStart()).toBe(false);

    release(payload());
    await started;
    expect(save.state()).toBe('awaiting-host');
    expect(save.locked()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores a second start while a request is pending (no duplicate emit)', async () => {
    await save.start(async () => payload(), emit, 'k');
    await save.start(async () => payload(), emit, 'k');
    expect(events).toHaveLength(1);
  });

  it('success clears the lock, reports the saved draft key and shows the host message', async () => {
    await save.start(async () => payload(), emit, 'key-1');
    const outcome = save.acknowledge({
      requestId: events[0].requestId,
      status: 'success',
      message: 'Prepared in demo',
    });
    expect(outcome).toEqual({ applied: true, savedKey: 'key-1' });
    expect(save.state()).toBe('saved');
    expect(save.message()).toBe('Prepared in demo');
    expect(save.locked()).toBe(false);
  });

  it('a matching error keeps everything editable and allows a new request with a new id', async () => {
    await save.start(async () => payload(), emit, 'k1');
    const first = events[0].requestId;
    expect(
      save.acknowledge({ requestId: first, status: 'error', message: 'Quota exceeded' }),
    ).toEqual({ applied: true });
    expect(save.state()).toBe('host-error');
    expect(save.message()).toBe('Quota exceeded');
    expect(save.locked()).toBe(false);
    expect(save.canStart()).toBe(true);

    await save.start(async () => payload(), emit, 'k2');
    expect(events).toHaveLength(2);
    expect(events[1].requestId).not.toBe(first);
  });

  it('ignores acknowledgements for other request ids (stale, duplicate or unknown)', async () => {
    await save.start(async () => payload(), emit, 'k');
    expect(save.acknowledge({ requestId: 'someone-else', status: 'success' })).toEqual({
      applied: false,
    });
    expect(save.state()).toBe('awaiting-host');

    const id = events[0].requestId;
    expect(save.acknowledge({ requestId: id, status: 'success' }).applied).toBe(true);
    expect(save.acknowledge({ requestId: id, status: 'error' }).applied).toBe(false); // late duplicate
    expect(save.state()).toBe('saved');
  });

  it('ignores a late result from an old request once a new request is pending', async () => {
    await save.start(async () => payload(), emit, 'k1');
    const old = events[0].requestId;
    save.acknowledge({ requestId: old, status: 'error' });
    await save.start(async () => payload(), emit, 'k2');
    expect(save.acknowledge({ requestId: old, status: 'success' }).applied).toBe(false);
    expect(save.state()).toBe('awaiting-host');
  });

  it('shows "no response" after 30 s and retries with the same request id and the exact same payload', async () => {
    await save.start(async () => payload(), emit, 'k');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1);
    expect(save.state()).toBe('awaiting-host');
    vi.advanceTimersByTime(1);
    expect(save.state()).toBe('no-response');
    expect(save.locked()).toBe(true); // still frozen: the host may yet answer

    expect(save.retry(emit)).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[1].requestId).toBe(events[0].requestId);
    expect(events[1].customization).toEqual(events[0].customization);
    expect(events[1].artworkBlob).toBe(events[0].artworkBlob); // Blobs are immutable and shared
    expect(events[1].previewBlob).toBe(events[0].previewBlob);
    expect(save.state()).toBe('awaiting-host');
  });

  it('a host that mutates the event it received cannot alter the pending request or its retry', async () => {
    await save.start(async () => payload(), emit, 'k');
    const original = JSON.stringify(events[0].customization);
    (events[0].customization as { values: Record<string, unknown> }).values['hacked'] = true;
    events[0].assets.push({ assetId: 'x' } as never);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    save.retry(emit);
    expect(JSON.stringify(events[1].customization)).toBe(original);
    expect(events[1].assets).toEqual([]);
    expect(events[1]).not.toBe(events[0]);
  });

  it('drops the request instead of sending it when the gate closes while the export is running', async () => {
    let open = true;
    let release!: (p: SavePayload) => void;
    const started = save.start(
      () => new Promise<SavePayload>((resolve) => (release = resolve)),
      emit,
      'k',
      () => open,
    );
    expect(save.state()).toBe('exporting');
    open = false; // e.g. the host set `disabled` meanwhile
    release(payload());
    await started;
    expect(events).toEqual([]);
    expect(save.state()).toBe('idle');
    expect(save.canStart()).toBe(true);
  });

  it('accepts a late success for the pending request after the timeout', async () => {
    await save.start(async () => payload(), emit, 'k');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(save.acknowledge({ requestId: events[0].requestId, status: 'success' }).applied).toBe(
      true,
    );
    expect(save.state()).toBe('saved');
  });

  it('retry does nothing unless a timeout happened', async () => {
    expect(save.retry(emit)).toBe(false);
    await save.start(async () => payload(), emit, 'k');
    expect(save.retry(emit)).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('an export failure surfaces, unlocks and keeps the draft', async () => {
    await expect(save.start(() => Promise.reject(new Error('boom')), emit, 'k')).rejects.toThrow(
      'boom',
    );
    expect(save.state()).toBe('export-error');
    expect(save.locked()).toBe(false);
    expect(events).toHaveLength(0);
    expect(save.canStart()).toBe(true);
  });

  it('cancel (new config / teardown) makes every later acknowledgement stale and drops an in-flight export', async () => {
    let release!: (p: SavePayload) => void;
    const started = save.start(
      () => new Promise<SavePayload>((resolve) => (release = resolve)),
      emit,
      'k',
    );
    save.cancel();
    release(payload());
    await started;
    expect(events).toHaveLength(0);
    expect(save.state()).toBe('idle');

    await save.start(async () => payload(), emit, 'k');
    const id = events[0].requestId;
    save.cancel();
    expect(save.acknowledge({ requestId: id, status: 'success' }).applied).toBe(false);
  });

  it('cancel stops the timeout timer', async () => {
    await save.start(async () => payload(), emit, 'k');
    save.cancel();
    vi.advanceTimersByTime(ACK_TIMEOUT_MS * 2);
    expect(save.state()).toBe('idle');
  });

  it('an edit after a result clears the old status line', async () => {
    await save.start(async () => payload(), emit, 'k');
    save.acknowledge({ requestId: events[0].requestId, status: 'success' });
    save.noteEdit();
    expect(save.state()).toBe('idle');
    expect(save.message()).toBeNull();
  });
});
