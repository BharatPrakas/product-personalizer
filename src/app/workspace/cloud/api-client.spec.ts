import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiClient, ApiClientError } from './api-client.service';
import { RuntimeConfig, type IssuedToken } from './runtime-config';

const URL = 'https://api.example/api/v1/plugins/personalization/mappings';

describe('ApiClient token handling', () => {
  let api: ApiClient;
  let runtime: RuntimeConfig;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiClient);
    runtime = TestBed.inject(RuntimeConfig);
    http = TestBed.inject(HttpTestingController);
    runtime.update({ apiBaseUrl: 'https://api.example', persistence: 'cloud' });
  });
  afterEach(() => http.verify());

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const providerOf = (...tokens: string[]) => {
    const queue = [...tokens];
    return vi.fn(async (_r: { forceRefresh: boolean }): Promise<IssuedToken> => ({ token: queue.shift() ?? 'exhausted' }));
  };

  it('fetches a token from the provider before the first request and sends it', async () => {
    runtime.setTokenProvider(providerOf('t1'));
    const result = api.get<string[]>('/mappings');
    await tick();
    const req = http.expectOne(URL);
    expect(req.request.headers.get('Authorization')).toBe('Bearer t1');
    req.flush({ data: ['x'], requestId: 'r' });
    expect((await result).data).toEqual(['x']);
  });

  it('on 401 asks for a fresh token and repeats the request once', async () => {
    const provider = providerOf('stale', 'fresh');
    runtime.setTokenProvider(provider);
    const result = api.get<string[]>('/mappings');
    await tick();
    http.expectOne(URL).flush({ error: { code: 'unauthenticated' } }, { status: 401, statusText: 'Unauthorized' });
    await tick();
    const retry = http.expectOne(URL);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer fresh');
    retry.flush({ data: ['ok'], requestId: 'r' });
    expect((await result).data).toEqual(['ok']);
    expect(provider.mock.calls.map(([r]) => r.forceRefresh)).toEqual([false, true]);
  });

  it('gives up after one repeat when the new token is rejected too', async () => {
    runtime.setTokenProvider(providerOf('a', 'b', 'c'));
    const result = api.get<string[]>('/mappings');
    const settled = result.catch((e: unknown) => e);
    await tick();
    http.expectOne(URL).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();
    http.expectOne(URL).flush(null, { status: 401, statusText: 'Unauthorized' });
    const error = await settled;
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(401);
  });

  it('does not repeat other failures', async () => {
    runtime.setTokenProvider(providerOf('a'));
    const settled = api.get('/mappings').catch((e: unknown) => e);
    await tick();
    http.expectOne(URL).flush(null, { status: 500, statusText: 'Server Error' });
    expect(((await settled) as ApiClientError).status).toBe(500);
  });

  it('retries without asking the host again when another request already renewed the token', async () => {
    const provider = providerOf('old', 'new');
    runtime.setTokenProvider(provider);
    const first = api.get('/mappings');
    await tick();
    const rejected = http.expectOne(URL);
    await runtime.refreshToken(); // a concurrent request renewed it: 'old' -> 'new'
    rejected.flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();
    const retry = http.expectOne(URL);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new');
    retry.flush({ data: [], requestId: 'r' });
    await first;
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 401 without a retry when there is no provider', async () => {
    runtime.update({ authToken: 'static' });
    const settled = api.get('/mappings').catch((e: unknown) => e);
    await tick();
    http.expectOne(URL).flush(null, { status: 401, statusText: 'Unauthorized' });
    expect(((await settled) as ApiClientError).status).toBe(401);
  });

  it('fails as unauthenticated, without calling the API, when no token can be obtained', async () => {
    runtime.setTokenProvider(async () => {
      throw new Error('signed out');
    });
    const error = (await api.get('/mappings').catch((e: unknown) => e)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
    http.expectNone(URL);
  });

  it('reports a missing API base URL before asking the host for a token', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const fresh = TestBed.inject(ApiClient);
    const provider = providerOf('x');
    TestBed.inject(RuntimeConfig).setTokenProvider(provider);
    const error = (await fresh.get('/mappings').catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe('not_configured');
    expect(provider).not.toHaveBeenCalled();
  });

  it('repeats a blob download after a 401 too', async () => {
    runtime.setTokenProvider(providerOf('stale', 'fresh'));
    const blob = api.getBlob('/files/1');
    await tick();
    http.expectOne(`${URL.replace('/mappings', '')}/files/1`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await tick();
    const retry = http.expectOne(`${URL.replace('/mappings', '')}/files/1`);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer fresh');
    retry.flush(new Blob(['abc']));
    expect((await blob).size).toBe(3);
  });
});
