import { TestBed } from '@angular/core/testing';
import { asZenBasketSdk, ZenBasketBridge } from './zenbasket-bridge';
import type { ZenBasketSdk } from './zb-sdk';

const sdk = (over: Partial<ZenBasketSdk> = {}): ZenBasketSdk =>
  ({
    version: 1,
    auth: { getAccessToken: vi.fn(async () => ({ token: 't', expiresAt: 123 })) },
    products: { search: vi.fn(async () => ({ items: [] })) },
    core: {},
    ...over,
  }) as unknown as ZenBasketSdk;

const elementWith = (value: unknown) => {
  const el = document.createElement('div');
  (el as unknown as Record<string, unknown>)['zbService'] = value;
  return el;
};

describe('asZenBasketSdk', () => {
  it('accepts an SDK-shaped object', () => {
    const value = sdk();
    expect(asZenBasketSdk(value)).toBe(value);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no version', { auth: { getAccessToken() {} } }],
    ['version 0', { version: 0, auth: { getAccessToken() {} } }],
    ['no auth', { version: 1 }],
    ['auth without getAccessToken', { version: 1, auth: {} }],
    ['the old empty facade', {}],
  ])('rejects %s', (_name, value) => {
    expect(asZenBasketSdk(value)).toBeNull();
  });
});

describe('ZenBasketBridge', () => {
  let bridge: ZenBasketBridge;
  beforeEach(() => {
    bridge = TestBed.inject(ZenBasketBridge);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('has no SDK before an element is attached', () => {
    expect(bridge.sdk()).toBeNull();
    expect(bridge.products()).toBeNull();
  });

  it('reads the SDK from the element it is attached to', () => {
    const value = sdk();
    bridge.attach(elementWith(value));
    expect(bridge.sdk()).toBe(value);
    expect(bridge.products()).toBe(value.products);
  });

  it('ignores an unusable zbService and warns once about it', () => {
    bridge.attach(elementWith({ unrelated: true }));
    expect(bridge.sdk()).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the element has no zbService at all', () => {
    bridge.attach(document.createElement('div'));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('products() is null when the host SDK has none', () => {
    bridge.attach(elementWith(sdk({ products: undefined })));
    expect(bridge.sdk()).not.toBeNull();
    expect(bridge.products()).toBeNull();
  });

  it('requests tokens through the SDK, passing forceRefresh', async () => {
    const value = sdk();
    bridge.attach(elementWith(value));
    expect(await bridge.requestToken({ forceRefresh: true })).toEqual({ token: 't', expiresAt: 123 });
    expect(value.auth.getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('fails to issue a token without an SDK', async () => {
    await expect(bridge.requestToken({ forceRefresh: false })).rejects.toThrow(/No ZenBasket SDK/);
  });

  it('detach only releases the element that is attached (replacement started first)', () => {
    const oldEl = elementWith(sdk());
    const newValue = sdk();
    const newEl = elementWith(newValue);
    bridge.attach(oldEl);
    bridge.attach(newEl);
    bridge.detach(oldEl);
    expect(bridge.sdk()).toBe(newValue);
    bridge.detach(newEl);
    expect(bridge.sdk()).toBeNull();
  });
});
