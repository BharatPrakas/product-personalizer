import {
  DirectUploadError,
  UploadDeduper,
  uploadDirect,
  type InitiateResult,
  type PresignedPut,
  type UploadGateway,
} from './direct-upload';

const blob = new Blob(['hello'], { type: 'image/png' });
const put = (overrides: Partial<PresignedPut> = {}): PresignedPut => ({
  uploadId: 'up-1',
  uploadUrl: 'https://bucket.example/pending/up-1?X-Amz-Signature=abc',
  method: 'PUT',
  headers: { 'Content-Type': 'image/png' },
  expiresIn: 300,
  ...overrides,
});
const http = (status: number, code = '', reason?: string) => ({ status, code, details: reason ? { reason } : undefined });
const fast = { retryDelayMs: 1 };

interface Harness {
  gateway: UploadGateway<string>;
  initiate: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
}

function harness(opts: { initiate?: Array<InitiateResult<string> | unknown>; complete?: Array<string | unknown> } = {}): Harness {
  const initiates = [...(opts.initiate ?? [{ kind: 'pending', put: put() }])];
  const completes = [...(opts.complete ?? ['asset-1'])];
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]);
  const initiate = vi.fn(async () => {
    const value = next(initiates);
    if (value instanceof Error || (typeof value === 'object' && value !== null && 'status' in value)) throw value;
    return value as InitiateResult<string>;
  });
  const complete = vi.fn(async () => {
    const value = next(completes);
    if (typeof value === 'string') return value;
    throw value;
  });
  return { gateway: { initiate, complete }, initiate, complete };
}

/** Scripts the browser's PUT. Each entry is a status, or an Error to throw (network failure). */
function stubPut(...script: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = script.length > 1 ? script.shift()! : script[0];
    if (step instanceof Error) throw step;
    return new Response(null, { status: step });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('uploadDirect', () => {
  it('asks for a URL, PUTs the bytes straight to it, then confirms', async () => {
    const calls = stubPut(200);
    const { gateway, initiate, complete } = harness();
    await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');

    expect(initiate).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(put().uploadUrl);
    expect(calls[0].init).toMatchObject({ method: 'PUT', body: blob, credentials: 'omit', mode: 'cors' });
    // Exactly the signed headers — no Authorization (the signature is the credential) and nothing else.
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(complete).toHaveBeenCalledWith('up-1');
    // Order: initiate -> PUT -> complete.
    expect(initiate.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
  });

  it('returns immediately when the Worker already has the file', async () => {
    const calls = stubPut(200);
    const { gateway, complete } = harness({ initiate: [{ kind: 'stored', result: 'existing' }] });
    await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('existing');
    expect(calls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  describe('network and storage failures', () => {
    it('retries a dropped connection and a 5xx, then succeeds', async () => {
      const calls = stubPut(new TypeError('Failed to fetch'), 503, 200);
      const { gateway } = harness();
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');
      expect(calls).toHaveLength(3);
    });

    it('gives up after the attempt budget with a retryable network error', async () => {
      const calls = stubPut(new TypeError('Failed to fetch'));
      const { gateway, complete } = harness();
      const error = await uploadDirect(blob, gateway, { ...fast, maxAttempts: 3 }).catch((e) => e);
      expect(error).toBeInstanceOf(DirectUploadError);
      expect(error).toMatchObject({ code: 'network', retryable: true });
      expect(calls).toHaveLength(3);
      expect(complete).not.toHaveBeenCalled();
    });

    it('does not retry a request the storage provider says is wrong', async () => {
      const calls = stubPut(400);
      const { gateway } = harness();
      const error = await uploadDirect(blob, gateway, fast).catch((e) => e);
      expect(error).toMatchObject({ code: 'storage', retryable: false, status: 400 });
      expect(calls).toHaveLength(1);
    });

    it('treats a timed-out PUT as retryable', async () => {
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError')))),
      );
      const { gateway } = harness();
      const error = await uploadDirect(blob, gateway, { ...fast, putTimeoutMs: 5, maxAttempts: 2 }).catch((e) => e);
      expect(error).toMatchObject({ code: 'timeout', retryable: true });
    });
  });

  describe('expired upload URL', () => {
    it('asks for a fresh URL for the SAME upload and uses it', async () => {
      const calls = stubPut(403, 200);
      const renewed = put({ uploadUrl: 'https://bucket.example/pending/up-1?X-Amz-Signature=fresh' });
      const { gateway, initiate } = harness({ initiate: [{ kind: 'pending', put: put() }, { kind: 'pending', put: renewed }] });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');
      expect(initiate).toHaveBeenNthCalledWith(2, 'up-1');
      expect(calls.map((c) => c.url)).toEqual([put().uploadUrl, renewed.uploadUrl]);
    });

    it('stops after a bounded number of renewals', async () => {
      stubPut(403);
      const { gateway, initiate } = harness();
      const error = await uploadDirect(blob, gateway, fast).catch((e) => e);
      expect(error).toMatchObject({ code: 'url-expired', retryable: true });
      expect(initiate).toHaveBeenCalledTimes(3); // the first URL plus two renewals
    });

    it('renews proactively when the URL is about to lapse (e.g. after a long backoff)', async () => {
      const calls = stubPut(200);
      const { gateway, initiate } = harness({ initiate: [{ kind: 'pending', put: put({ expiresIn: 5 }) }, { kind: 'pending', put: put({ uploadUrl: 'https://bucket.example/new' }) }] });
      await uploadDirect(blob, gateway, fast);
      expect(initiate).toHaveBeenCalledTimes(2);
      expect(calls[0].url).toBe('https://bucket.example/new');
    });

    it('adopts the stored asset if the Worker finished the upload while the client was retrying', async () => {
      stubPut(403);
      const { gateway, complete } = harness({ initiate: [{ kind: 'pending', put: put() }, { kind: 'stored', result: 'done-elsewhere' }] });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('done-elsewhere');
      expect(complete).not.toHaveBeenCalled();
    });
  });

  describe('confirmation', () => {
    it('repeats a confirmation whose response was lost, without re-uploading the bytes', async () => {
      const calls = stubPut(200);
      const { gateway, complete } = harness({ complete: [http(0), http(503, 'storage_unavailable'), 'asset-1'] });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');
      expect(complete).toHaveBeenCalledTimes(3);
      expect(calls).toHaveLength(1);
    });

    it('waits out a confirmation that is already in progress (concurrent tab / retry)', async () => {
      stubPut(200);
      const { gateway, complete } = harness({ complete: [http(409, 'upload_in_progress'), 'asset-1'] });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');
      expect(complete).toHaveBeenCalledTimes(2);
    });

    it('sends the file again when the Worker reports the object never arrived', async () => {
      const calls = stubPut(200);
      const { gateway } = harness({ complete: [http(409, 'upload_missing'), 'asset-1'] });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');
      expect(calls).toHaveLength(2);
    });

    it('starts a brand-new upload when the old one expired server-side', async () => {
      const calls = stubPut(200);
      const second = put({ uploadId: 'up-2', uploadUrl: 'https://bucket.example/pending/up-2' });
      const { gateway, complete } = harness({
        initiate: [{ kind: 'pending', put: put() }, { kind: 'pending', put: second }],
        complete: [http(410, 'upload_expired'), 'asset-2'],
      });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-2');
      expect(calls.map((c) => c.url)).toEqual([put().uploadUrl, second.uploadUrl]);
      expect(complete).toHaveBeenLastCalledWith('up-2');
    });

    it('never retries a rejected file and reports the server’s reason', async () => {
      stubPut(200);
      const { gateway, complete } = harness({ complete: [http(422, 'upload_rejected', 'invalid_content')] });
      const error = await uploadDirect(blob, gateway, fast).catch((e) => e);
      expect(error).toMatchObject({ code: 'rejected', retryable: false, reason: 'invalid_content' });
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('surfaces a persistently failing confirmation as retryable', async () => {
      stubPut(200);
      const { gateway } = harness({ complete: [http(503, 'storage_unavailable')] });
      const error = await uploadDirect(blob, gateway, { ...fast, maxAttempts: 2 }).catch((e) => e);
      expect(error).toMatchObject({ code: 'confirm-failed', retryable: true });
    });
  });

  describe('initiation failures', () => {
    it.each([
      [415, 'unsupported', false],
      [413, 'too-large', false],
      [401, 'unauthorized', false],
    ])('maps HTTP %s to %s without retrying', async (status, code, retryable) => {
      const calls = stubPut(200);
      const { gateway, initiate } = harness({ initiate: [http(status)] });
      const error = await uploadDirect(blob, gateway, fast).catch((e) => e);
      expect(error).toMatchObject({ code, retryable });
      expect(initiate).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(0);
    });

    it('reports a Worker without direct uploads so the caller can fall back', async () => {
      const { gateway } = harness({ initiate: [http(503, 'direct_upload_not_configured')] });
      expect(await uploadDirect(blob, gateway, fast).catch((e) => e)).toMatchObject({ code: 'not-configured' });
    });

    it('retries a rate limit', async () => {
      stubPut(200);
      const { gateway, initiate } = harness({ initiate: [http(429, 'rate_limited'), { kind: 'pending', put: put() }] });
      await expect(uploadDirect(blob, gateway, fast)).resolves.toBe('asset-1');
      expect(initiate).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancellation', () => {
    it('aborts an in-flight PUT, never confirms, and surfaces an AbortError', async () => {
      const controller = new AbortController();
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')))),
      );
      const { gateway, complete } = harness();
      const pending = uploadDirect(blob, gateway, { ...fast, signal: controller.signal }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(DOMException);
      expect(error.name).toBe('AbortError');
      expect(complete).not.toHaveBeenCalled();
    });

    it('does not start at all when already aborted, and stops waiting between retries', async () => {
      const controller = new AbortController();
      controller.abort();
      const { gateway, initiate } = harness();
      expect(await uploadDirect(blob, gateway, { signal: controller.signal }).catch((e) => e)).toMatchObject({ name: 'AbortError' });
      expect(initiate).not.toHaveBeenCalled();

      const mid = new AbortController();
      stubPut(503);
      const { gateway: g2 } = harness();
      const pending = uploadDirect(blob, g2, { signal: mid.signal, retryDelayMs: 60_000 }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 5));
      mid.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
    });
  });

  describe('progress', () => {
    class FakeXhr {
      static last: FakeXhr;
      upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      ontimeout?: () => void;
      onabort?: () => void;
      status = 200;
      timeout = 0;
      withCredentials = true;
      headers: Record<string, string> = {};
      method = '';
      url = '';
      body: unknown;
      constructor() {
        FakeXhr.last = this;
      }
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      send(body: unknown) {
        this.body = body;
        queueMicrotask(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 5 });
          this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 });
          this.onload?.();
        });
      }
      abort() {
        this.onabort?.();
      }
    }

    it('uses XMLHttpRequest when progress is requested, with the same signed request', async () => {
      vi.stubGlobal('XMLHttpRequest', FakeXhr);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const seen: number[] = [];
      const { gateway } = harness();
      await uploadDirect(blob, gateway, { ...fast, onProgress: (p) => seen.push(p.loaded / p.total) });
      expect(seen).toEqual([0.4, 1]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(FakeXhr.last).toMatchObject({ method: 'PUT', url: put().uploadUrl, headers: { 'Content-Type': 'image/png' }, withCredentials: false, body: blob });
    });
  });
});

describe('UploadDeduper', () => {
  it('shares one run between concurrent callers of the same key, and allows a new run afterwards', async () => {
    const dedupe = new UploadDeduper<string>();
    let runs = 0;
    const start = () => new Promise<string>((resolve) => setTimeout(() => resolve(`run-${++runs}`), 5));
    const [a, b] = await Promise.all([dedupe.run('k', start), dedupe.run('k', start)]);
    expect([a, b]).toEqual(['run-1', 'run-1']);
    expect(await dedupe.run('k', start)).toBe('run-2');
    expect(await Promise.all([dedupe.run('x', start), dedupe.run('y', start)])).toEqual(['run-3', 'run-4']);
  });

  it('does not cache a failure', async () => {
    const dedupe = new UploadDeduper<string>();
    await expect(dedupe.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(dedupe.run('k', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
