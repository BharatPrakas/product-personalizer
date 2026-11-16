import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DirectUploadError } from '../../customizer/util/direct-upload';
import { ApiClient, type UploadedAssetDto } from './api-client.service';
import { AssetSyncService } from './asset-sync.service';
import { RuntimeConfig } from './runtime-config';
import { LocalAssetLibrary } from '../../customizer/services/local-asset-library.service';

const BASE = 'https://api.example/api/v1/plugins/personalization';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const asset = (overrides: Partial<UploadedAssetDto> = {}): UploadedAssetDto => ({
  id: 'asset-1',
  assetId: 'asset-1',
  uploadId: 'up-1',
  configId: null,
  objectKey: 'stores/s/product-personalization/assets/x.png',
  originalFilename: 'image',
  contentType: 'image/png',
  sizeBytes: 5,
  size: 5,
  width: 1,
  height: 1,
  checksumSha256: 'abc',
  status: 'stored',
  clientRef: null,
  createdAt: 1,
  deliveryUrl: 'https://api.example/api/v1/storefront/personalization/assets/asset-1?sig=s',
  publicUrl: null,
  ...overrides,
});

const initiation = {
  uploadId: 'up-1',
  assetId: 'asset-1',
  status: 'pending',
  uploadUrl: 'https://bucket.example/pending/up-1?X-Amz-Signature=sig',
  method: 'PUT',
  headers: { 'Content-Type': 'image/png' },
  expiresIn: 300,
};

describe('merchant direct uploads (ApiClient)', () => {
  let api: ApiClient;
  let http: HttpTestingController;
  let storage: Array<{ url: string; init: RequestInit }>;
  let storageStatus: number;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiClient);
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(RuntimeConfig).update({ apiBaseUrl: 'https://api.example', persistence: 'cloud' });
    storage = [];
    storageStatus = 200;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      storage.push({ url, init });
      return new Response(null, { status: storageStatus });
    });
  });
  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
  });

  it('requests a presigned URL, uploads straight to storage, confirms, and resolves to the verified asset', async () => {
    const blob = new Blob(['hello'], { type: 'image/png' });
    const result = api.uploadAsset(blob, { clientRef: 'idb:1', configId: 'cfg-1', filename: 'image', retryDelayMs: 1 });

    await tick();
    const init = http.expectOne(`${BASE}/assets/upload-url`);
    expect(init.request.method).toBe('POST');
    expect(init.request.body).toEqual({
      contentType: 'image/png', size: 5, purpose: 'merchant-asset', filename: 'image', configId: 'cfg-1', clientRef: 'idb:1',
    });
    // The merchant's token authenticates the Worker calls only.
    init.flush({ data: initiation, requestId: 'r' });
    await tick();
    expect(storage).toHaveLength(1);
    expect(storage[0].url).toBe(initiation.uploadUrl);
    expect(storage[0].init).toMatchObject({ method: 'PUT', body: blob, credentials: 'omit' });
    expect(storage[0].init.headers).toEqual({ 'Content-Type': 'image/png' });

    await tick();
    const confirm = http.expectOne(`${BASE}/assets/complete`);
    expect(confirm.request.body).toEqual({ uploadId: 'up-1' });
    confirm.flush({ data: asset(), requestId: 'r' });
    expect(await result).toMatchObject({ assetId: 'asset-1', status: 'stored', publicUrl: null });
  });

  it('returns an already-stored asset without uploading anything', async () => {
    const result = api.uploadAsset(new Blob(['hello'], { type: 'image/png' }), { clientRef: 'idb:done' });
    await tick();
    http.expectOne(`${BASE}/assets/upload-url`).flush({
      data: { uploadId: null, assetId: 'asset-1', status: 'stored', uploadUrl: null, method: null, headers: {}, expiresIn: 0, asset: asset() },
      requestId: 'r',
    });
    expect((await result).assetId).toBe('asset-1');
    expect(storage).toHaveLength(0);
  });

  it('declares fonts and unknown types honestly (the Worker decides from the bytes)', async () => {
    const result = api.uploadAsset(new Blob(['x']), { filename: 'Brand', retryDelayMs: 1 }).catch((e) => e);
    await tick();
    const init = http.expectOne(`${BASE}/assets/upload-url`);
    expect(init.request.body).toMatchObject({ contentType: 'application/octet-stream', filename: 'Brand' });
    init.flush({ error: { code: 'unsupported_media_type', message: 'no' } }, { status: 415, statusText: 'x' });
    expect(await result).toBeInstanceOf(DirectUploadError);
  });

  it('surfaces a rejected file with the server’s reason and does not retry', async () => {
    const result = api.uploadAsset(new Blob(['hello'], { type: 'image/png' }), { retryDelayMs: 1 }).catch((e) => e);
    await tick();
    http.expectOne(`${BASE}/assets/upload-url`).flush({ data: initiation, requestId: 'r' });
    await tick(5);
    http.expectOne(`${BASE}/assets/complete`).flush(
      { error: { code: 'upload_rejected', message: 'x', details: { reason: 'size_mismatch' } } },
      { status: 422, statusText: 'x' },
    );
    const error = await result;
    expect(error).toMatchObject({ code: 'rejected', reason: 'size_mismatch', retryable: false });
  });

  it('falls back to the proxied upload only when the Worker has direct uploads switched off', async () => {
    const blob = new Blob(['hello'], { type: 'image/png' });
    const result = api.uploadAsset(blob, { clientRef: 'idb:1', filename: 'image' });
    await tick();
    http.expectOne(`${BASE}/assets/upload-url`).flush(
      { error: { code: 'direct_upload_not_configured', message: 'x' } },
      { status: 503, statusText: 'x' },
    );
    await tick();
    const proxied = http.expectOne((r) => r.url === `${BASE}/assets` && r.method === 'POST');
    expect(proxied.request.params.get('clientRef')).toBe('idb:1');
    expect(proxied.request.body).toBe(blob);
    proxied.flush({ data: { ...asset(), uploadId: undefined }, requestId: 'r' });
    expect(await result).toMatchObject({ assetId: 'asset-1', uploadId: null, publicUrl: null });
    expect(storage).toHaveLength(0);
  });

  it('does not resolve (so a configuration is never saved against it) until the Worker has verified the file', async () => {
    let settled = false;
    const result = api.uploadAsset(new Blob(['hello'], { type: 'image/png' }), { retryDelayMs: 1 }).then(() => (settled = true));
    await tick();
    http.expectOne(`${BASE}/assets/upload-url`).flush({ data: initiation, requestId: 'r' });
    await tick(5);
    expect(storage).toHaveLength(1); // bytes are at the provider...
    expect(settled).toBe(false); // ...but the asset is not usable until confirmed
    http.expectOne(`${BASE}/assets/complete`).flush({ data: asset(), requestId: 'r' });
    await result;
    expect(settled).toBe(true);
  });

  it('cancels cleanly: aborts the PUT and never confirms', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')))),
    );
    const controller = new AbortController();
    const result = api.uploadAsset(new Blob(['hello'], { type: 'image/png' }), { signal: controller.signal }).catch((e) => e);
    await tick();
    http.expectOne(`${BASE}/assets/upload-url`).flush({ data: initiation, requestId: 'r' });
    await tick(5);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    http.expectNone(`${BASE}/assets/complete`);
  });

  it('asks for a short-lived private download URL per call', async () => {
    const result = api.getAssetDownloadUrl('asset 1');
    await tick();
    http.expectOne(`${BASE}/assets/asset%201/url`).flush({ data: { url: 'https://bucket.example/x?X-Amz-Signature=s', expiresIn: 60 }, requestId: 'r' });
    expect(await result).toEqual({ url: 'https://bucket.example/x?X-Amz-Signature=s', expiresIn: 60 });
  });
});

describe('AssetSyncService with direct uploads', () => {
  let sync: AssetSyncService;
  let api: ApiClient;
  let library: LocalAssetLibrary;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    sync = TestBed.inject(AssetSyncService);
    api = TestBed.inject(ApiClient);
    library = TestBed.inject(LocalAssetLibrary);
  });

  const config = (src: string) => ({ id: 'cfg-1', mockups: [{ id: 'm1', src }] }) as never;

  it('rewrites local references to the VERIFIED delivery URL, and uploads each ref once', async () => {
    vi.spyOn(library, 'get').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const upload = vi.spyOn(api, 'uploadAsset').mockResolvedValue(asset());
    const result = await sync.syncConfigAssets(config('idb:one'));
    expect(upload).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ clientRef: 'idb:one', configId: 'cfg-1' }));
    expect(result.config).toMatchObject({ mockups: [{ src: asset().deliveryUrl }] });
    expect(result.uploadedCount).toBe(1);

    await sync.syncConfigAssets(config('idb:one')); // cached for the session
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('shares one upload between concurrent syncs of the same reference', async () => {
    vi.spyOn(library, 'get').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    let release!: () => void;
    const upload = vi.spyOn(api, 'uploadAsset').mockImplementation(() => new Promise((resolve) => (release = () => resolve(asset()))));
    const a = sync.syncConfigAssets(config('idb:two'));
    const b = sync.syncConfigAssets(config('idb:two'));
    await tick();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(ra.mapping['idb:two']).toBe(rb.mapping['idb:two']);
  });

  it('never rewrites a reference to an unverified asset: a failed upload fails the sync', async () => {
    vi.spyOn(library, 'get').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    vi.spyOn(api, 'uploadAsset').mockRejectedValue(new DirectUploadError('rejected', 'no', false, 422));
    await expect(sync.syncConfigAssets(config('idb:three'))).rejects.toBeInstanceOf(DirectUploadError);
  });

  it('passes cancellation through to the upload', async () => {
    vi.spyOn(library, 'get').mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const upload = vi.spyOn(api, 'uploadAsset').mockResolvedValue(asset());
    const controller = new AbortController();
    await sync.syncConfigAssets(config('idb:four'), { signal: controller.signal });
    expect(upload.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });
});
