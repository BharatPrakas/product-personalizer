/**
 * Direct browser-to-object-storage upload, independent of Angular and of the storage provider.
 *
 *   1. ask the Worker for a presigned PUT (`gateway.initiate`)
 *   2. PUT the bytes straight to the provider — Cloudflare R2 or AWS S3, the browser cannot tell
 *   3. ask the Worker to verify the object (`gateway.complete`) and return the verified asset
 *
 * The Worker decides the provider; this module only ever sees "a URL, a method, some headers". Callers
 * (merchant asset upload, shopper upload) supply a small gateway that knows THEIR two endpoints and
 * their authentication, so no provider-specific or endpoint-specific logic leaks into components.
 *
 * Handled here: cancellation (AbortSignal), per-attempt timeout, upload progress, transient network /
 * 5xx retries with backoff, an expired URL (asks the Worker for a fresh one for the SAME upload), a lost
 * confirmation (completion is idempotent, so it is simply repeated), an object that never arrived
 * (re-sent), and a rejected file (never retried). It never retries a request the server has said is
 * wrong.
 */

export type DirectUploadErrorCode =
  | 'aborted'
  | 'network'
  | 'timeout'
  | 'url-expired'
  | 'rejected'
  | 'unsupported'
  | 'too-large'
  | 'rate-limited'
  | 'unauthorized'
  | 'not-configured'
  | 'storage'
  | 'confirm-failed'
  | 'unknown';

/** A failure with a stable code, safe to map to a user-facing message (no URLs, keys or file content). */
export class DirectUploadError extends Error {
  constructor(
    readonly code: DirectUploadErrorCode,
    message: string,
    /** Whether trying the whole upload again later could plausibly work. */
    readonly retryable: boolean,
    readonly status?: number,
    /** The server's reason code for a rejection (`size_mismatch`, `invalid_content`, ...). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'DirectUploadError';
  }
}

export interface PresignedPut {
  uploadId: string;
  uploadUrl: string;
  method: 'PUT';
  /** Sent unchanged: they are part of the signature. */
  headers: Record<string, string>;
  /** Seconds the URL stays valid, counted from when it was issued. */
  expiresIn: number;
}

export type InitiateResult<T> =
  | { kind: 'pending'; put: PresignedPut }
  /** The Worker already has this file (an idempotent re-initiation): nothing to upload. */
  | { kind: 'stored'; result: T };

/** The two Worker calls around the PUT. Errors thrown from them should carry `status` / `code` / `details`. */
export interface UploadGateway<T> {
  /** `renewUploadId` asks for a fresh URL for an upload that is still open instead of a new upload. */
  initiate(renewUploadId?: string): Promise<InitiateResult<T>>;
  complete(uploadId: string): Promise<T>;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadOptions {
  signal?: AbortSignal;
  /** Reliable byte-level progress needs XMLHttpRequest, which is used automatically when this is set. */
  onProgress?: (progress: UploadProgress) => void;
  /** Per-attempt PUT timeout (default 120 s). */
  putTimeoutMs?: number;
  /** PUT / confirm attempts for transient failures (default 3). */
  maxAttempts?: number;
  /** First backoff delay; doubles each retry (default 500 ms). */
  retryDelayMs?: number;
}

const DEFAULT_PUT_TIMEOUT_MS = 120_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_URL_RENEWALS = 2;
const MAX_ROUNDS = 3;
/** Renew a URL that is this close to expiring rather than risk a 403 mid-upload. */
const EXPIRY_MARGIN_MS = 10_000;

// ---- error classification -------------------------------------------------------------------

interface Failure {
  status: number;
  code: string;
  reason?: string;
}

/** Reads `status` / `code` / `details.reason` off whatever the gateway's transport threw. */
function failureOf(error: unknown): Failure {
  const e = error as { status?: unknown; code?: unknown; details?: unknown } | null;
  const details = e?.details as { reason?: unknown } | undefined;
  return {
    status: typeof e?.status === 'number' ? e.status : 0,
    code: typeof e?.code === 'string' ? e.code : '',
    reason: typeof details?.reason === 'string' ? details.reason : undefined,
  };
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

type Classified =
  | { kind: 'missing' }
  | { kind: 'in-progress' }
  | { kind: 'upload-expired' }
  | { kind: 'rejected'; error: DirectUploadError }
  | { kind: 'fatal'; error: DirectUploadError }
  | { kind: 'transient'; error: DirectUploadError };

function classify(error: unknown): Classified {
  const { status, code, reason } = failureOf(error);
  if (code === 'upload_missing') return { kind: 'missing' };
  if (code === 'upload_in_progress') return { kind: 'in-progress' };
  if (code === 'upload_expired') return { kind: 'upload-expired' };
  if (code === 'upload_rejected' || status === 422) {
    return { kind: 'rejected', error: new DirectUploadError('rejected', 'The file was rejected.', false, status, reason) };
  }
  if (status === 413) return { kind: 'fatal', error: new DirectUploadError('too-large', 'The file is too large.', false, status) };
  if (status === 415) return { kind: 'fatal', error: new DirectUploadError('unsupported', 'This file type is not supported.', false, status) };
  if (status === 401 || status === 403) {
    return { kind: 'fatal', error: new DirectUploadError('unauthorized', 'The upload was not authorized.', false, status) };
  }
  if (code === 'direct_upload_not_configured') {
    return { kind: 'fatal', error: new DirectUploadError('not-configured', 'Direct upload is not available.', false, status) };
  }
  if (status === 429 || code === 'too_many_open_uploads') {
    return { kind: 'transient', error: new DirectUploadError('rate-limited', 'Too many requests.', true, status) };
  }
  if (status === 0 || status >= 500 || status === 408) {
    return { kind: 'transient', error: new DirectUploadError(status === 0 ? 'network' : 'storage', 'The service could not be reached.', true, status) };
  }
  return { kind: 'fatal', error: new DirectUploadError('unknown', 'The upload failed.', false, status) };
}

// ---- timing ---------------------------------------------------------------------------------

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- the PUT --------------------------------------------------------------------------------

type PutOutcome =
  | { ok: true }
  /** 403: the signature is no longer valid (expired) or never was. Ask for a fresh URL. */
  | { ok: false; kind: 'expired'; status: number }
  | { ok: false; kind: 'transient'; status: number; code: 'network' | 'timeout' | 'storage' }
  | { ok: false; kind: 'fatal'; status: number };

function outcomeForStatus(status: number): PutOutcome {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 403) return { ok: false, kind: 'expired', status };
  if (status === 408 || status === 429 || status >= 500) return { ok: false, kind: 'transient', status, code: 'storage' };
  return { ok: false, kind: 'fatal', status };
}

async function putWithFetch(blob: Blob, put: PresignedPut, signal: AbortSignal | undefined, timeoutMs: number): Promise<PutOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(put.uploadUrl, {
      method: put.method,
      headers: put.headers,
      body: blob,
      mode: 'cors',
      // The signature is the credential; never send cookies to the storage host.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return outcomeForStatus(response.status);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (isAbort(error) || timeout.aborted) return { ok: false, kind: 'transient', status: 0, code: 'timeout' };
    // A TypeError here is a network failure or a CORS rejection; both look alike to a browser.
    return { ok: false, kind: 'transient', status: 0, code: 'network' };
  }
}

function putWithXhr(
  blob: Blob,
  put: PresignedPut,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onProgress: (p: UploadProgress) => void,
): Promise<PutOutcome> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(put.method, put.uploadUrl);
    for (const [name, value] of Object.entries(put.headers)) xhr.setRequestHeader(name, value);
    xhr.timeout = timeoutMs;
    xhr.withCredentials = false;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      done();
      resolve(outcomeForStatus(xhr.status));
    };
    xhr.onerror = () => {
      done();
      resolve({ ok: false, kind: 'transient', status: 0, code: 'network' });
    };
    xhr.ontimeout = () => {
      done();
      resolve({ ok: false, kind: 'transient', status: 0, code: 'timeout' });
    };
    xhr.onabort = () => {
      done();
      if (signal?.aborted) reject(abortError());
      else resolve({ ok: false, kind: 'transient', status: 0, code: 'network' });
    };
    if (signal?.aborted) {
      done();
      reject(abortError());
      return;
    }
    xhr.send(blob);
  });
}

function putOnce(blob: Blob, put: PresignedPut, options: UploadOptions): Promise<PutOutcome> {
  const timeoutMs = options.putTimeoutMs ?? DEFAULT_PUT_TIMEOUT_MS;
  return options.onProgress && typeof XMLHttpRequest !== 'undefined'
    ? putWithXhr(blob, put, options.signal, timeoutMs, options.onProgress)
    : putWithFetch(blob, put, options.signal, timeoutMs);
}

// ---- orchestration --------------------------------------------------------------------------

/**
 * Uploads `blob` straight to object storage and returns what the Worker verified. See the file comment
 * for the retry semantics. Throws {@link DirectUploadError}, or a DOMException `AbortError` when the
 * caller's signal aborts.
 */
export async function uploadDirect<T>(blob: Blob, gateway: UploadGateway<T>, options: UploadOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.maxAttempts ?? DEFAULT_ATTEMPTS);
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const { signal } = options;
  const backoff = (attempt: number) => delay(baseDelay * 2 ** (attempt - 1), signal);

  /** Gateway calls: transient failures are retried; anything else surfaces as a DirectUploadError. */
  const call = async <R>(fn: () => Promise<R>): Promise<R> => {
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      try {
        return await fn();
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw abortError();
        if (error instanceof DirectUploadError) throw error;
        const verdict = classify(error);
        if (verdict.kind === 'transient' && attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        if ('error' in verdict) throw verdict.error;
        throw new DirectUploadError('unknown', 'The upload failed.', false, failureOf(error).status);
      }
    }
  };

  let initiated = await call(() => gateway.initiate());
  if (initiated.kind === 'stored') return initiated.result;
  let put = initiated.put;
  let issuedAt = Date.now();

  /** A fresh URL for the SAME upload (so no second asset is created). May turn out to be already stored. */
  const renew = async (): Promise<{ stored: T } | null> => {
    const renewed = await call(() => gateway.initiate(put.uploadId));
    if (renewed.kind === 'stored') return { stored: renewed.result };
    put = renewed.put;
    issuedAt = Date.now();
    return null;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // ---- PUT, with renewal on expiry and retry on transient failure ----
    let renewals = 0;
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      if (Date.now() - issuedAt > put.expiresIn * 1000 - EXPIRY_MARGIN_MS) {
        const done = await renew();
        if (done) return done.stored;
      }
      const outcome = await putOnce(blob, put, options);
      if (outcome.ok) break;
      if (outcome.kind === 'expired') {
        if (renewals++ >= MAX_URL_RENEWALS) {
          throw new DirectUploadError('url-expired', 'The upload link expired. Please try again.', true, outcome.status);
        }
        const done = await renew();
        if (done) return done.stored;
        attempt = 0; // a fresh URL restarts the retry budget
        continue;
      }
      if (outcome.kind === 'fatal') {
        throw new DirectUploadError('storage', 'The file could not be uploaded.', false, outcome.status);
      }
      if (attempt >= attempts) {
        throw new DirectUploadError(outcome.code, 'The file could not be uploaded. Check your connection and try again.', true, outcome.status);
      }
      await backoff(attempt);
    }

    // ---- confirm (idempotent, so a lost response is safe to repeat) ----
    let missing = false;
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
      try {
        return await gateway.complete(put.uploadId);
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw abortError();
        const verdict = error instanceof DirectUploadError ? ({ kind: 'fatal', error } as const) : classify(error);
        if (verdict.kind === 'missing') {
          missing = true; // the object did not arrive (or was swept): send it again
          break;
        }
        if (verdict.kind === 'upload-expired') {
          initiated = await call(() => gateway.initiate()); // a brand-new upload
          if (initiated.kind === 'stored') return initiated.result;
          put = initiated.put;
          issuedAt = Date.now();
          missing = true;
          break;
        }
        if ((verdict.kind === 'transient' || verdict.kind === 'in-progress') && attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        if (verdict.kind === 'in-progress') {
          throw new DirectUploadError('confirm-failed', 'The upload is still being processed. Please try again.', true, 409);
        }
        if (verdict.kind === 'transient') {
          if (verdict.error.code === 'rate-limited') throw verdict.error;
          throw new DirectUploadError('confirm-failed', 'The upload could not be confirmed. Please try again.', true, failureOf(error).status);
        }
        if ('error' in verdict) throw verdict.error;
        throw new DirectUploadError('unknown', 'The upload failed.', false);
      }
    }
    if (!missing) break;
  }
  throw new DirectUploadError('confirm-failed', 'The upload could not be confirmed. Please try again.', true);
}

/**
 * Collapses concurrent uploads of the same logical file (by caller-chosen key) into one: the second caller
 * awaits the first's promise instead of starting another upload.
 */
export class UploadDeduper<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = start().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
