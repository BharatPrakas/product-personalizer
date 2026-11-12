import { TestBed } from '@angular/core/testing';
import { RuntimeConfig, type IssuedToken } from './runtime-config';

describe('RuntimeConfig token handling', () => {
  let runtime: RuntimeConfig;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    runtime = TestBed.inject(RuntimeConfig);
  });
  afterEach(() => vi.useRealTimers());

  const provider = (...tokens: IssuedToken[]) => {
    const queue = [...tokens];
    return vi.fn(async (_request: { forceRefresh: boolean }) => {
      const next = queue.shift();
      if (!next) throw new Error('no token');
      return next;
    });
  };

  it('uses the configured token as-is without a provider', async () => {
    runtime.update({ authToken: 'static' });
    expect(await runtime.ensureToken()).toBe('static');
    expect(await runtime.refreshToken()).toBe(false);
  });

  it('asks the provider when there is no token yet, then reuses the issued one', async () => {
    const p = provider({ token: 'a', expiresAt: 1_000_000 + 600_000 });
    runtime.setTokenProvider(p);
    expect(await runtime.ensureToken()).toBe('a');
    expect(await runtime.ensureToken()).toBe('a');
    expect(p).toHaveBeenCalledTimes(1);
    expect(p).toHaveBeenCalledWith({ forceRefresh: false });
    expect(runtime.authToken()).toBe('a');
  });

  it('keeps an explicitly configured token until it has to be refreshed', async () => {
    const p = provider({ token: 'from-sdk' });
    runtime.update({ authToken: 'explicit' });
    runtime.setTokenProvider(p);
    expect(await runtime.ensureToken()).toBe('explicit');
    expect(p).not.toHaveBeenCalled();
    expect(await runtime.refreshToken()).toBe(true);
    expect(p).toHaveBeenCalledWith({ forceRefresh: true });
    expect(runtime.authToken()).toBe('from-sdk');
  });

  it('renews a token that is about to expire before it is used again', async () => {
    const p = provider({ token: 'old', expiresAt: 1_000_000 + 20_000 }, { token: 'new', expiresAt: 1_000_000 + 600_000 });
    runtime.setTokenProvider(p);
    expect(await runtime.ensureToken()).toBe('old'); // just fetched: returned as issued, even if short-lived
    expect(await runtime.ensureToken()).toBe('new'); // already inside the 30 s skew: renewed before use
    expect(p).toHaveBeenCalledTimes(2);
    expect(await runtime.ensureToken()).toBe('new');
    expect(p).toHaveBeenCalledTimes(2);
  });

  it('does not renew a token without an expiry', async () => {
    const p = provider({ token: 'a' });
    runtime.setTokenProvider(p);
    await runtime.ensureToken();
    vi.setSystemTime(9_999_999_999);
    expect(await runtime.ensureToken()).toBe('a');
    expect(p).toHaveBeenCalledTimes(1);
  });

  it('shares one provider call between concurrent refreshes', async () => {
    let release!: (t: IssuedToken) => void;
    const p = vi.fn(() => new Promise<IssuedToken>((resolve) => (release = resolve)));
    runtime.setTokenProvider(p);
    const both = Promise.all([runtime.refreshToken(), runtime.refreshToken()]);
    release({ token: 'shared' });
    expect(await both).toEqual([true, true]);
    expect(p).toHaveBeenCalledTimes(1);
  });

  it('reports failure when the provider rejects or returns nothing usable', async () => {
    runtime.setTokenProvider(async () => {
      throw new Error('signed out');
    });
    expect(await runtime.refreshToken()).toBe(false);
    await expect(runtime.ensureToken()).rejects.toThrow(/could not be obtained/);
    runtime.setTokenProvider(async () => ({ token: '' }));
    expect(await runtime.refreshToken()).toBe(false);
  });

  it('lets a token assigned by the host replace the issued one', async () => {
    runtime.setTokenProvider(provider({ token: 'issued' }));
    await runtime.ensureToken();
    runtime.setAuthToken('assigned');
    expect(runtime.authToken()).toBe('assigned');
  });

  it('an update without a token keeps the issued one', async () => {
    runtime.setTokenProvider(provider({ token: 'issued' }));
    await runtime.ensureToken();
    runtime.update({ apiBaseUrl: 'https://api.example', authToken: undefined });
    expect(runtime.authToken()).toBe('issued');
  });

  it('clearTokenProvider only removes the provider that is installed', async () => {
    const first = provider({ token: '1' });
    const second = provider({ token: '2' });
    runtime.setTokenProvider(first);
    runtime.setTokenProvider(second); // a replacement element started before the old one was destroyed
    runtime.clearTokenProvider(first);
    expect(await runtime.ensureToken()).toBe('2');
    runtime.clearTokenProvider(second);
    expect(await runtime.refreshToken()).toBe(false);
  });
});
