import { ExtensionChannel, newInstanceId } from './extension-channel';

describe('ExtensionChannel', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => host.remove());

  it('dispatches a bubbling, composed zb:event envelope', () => {
    const seen: CustomEvent[] = [];
    document.addEventListener('zb:event', (e) => seen.push(e as CustomEvent), { once: true });
    new ExtensionChannel(host, () => 'inst-1').emit('gate', { allowed: false, reason: 'Add a photo' });
    expect(seen).toHaveLength(1);
    expect(seen[0].bubbles).toBe(true);
    expect(seen[0].composed).toBe(true);
    expect(seen[0].detail).toMatchObject({
      contract: 1,
      extensionId: 'personalization',
      instanceId: 'inst-1',
      slot: 'storefront.product.detail.block',
      type: 'gate',
      data: { allowed: false, reason: 'Add a photo' },
    });
    expect(typeof seen[0].detail.ts).toBe('number');
  });

  it('reads the instance id on every send, so a host-assigned id that arrives late is honoured', () => {
    let id = 'generated';
    const channel = new ExtensionChannel(host, () => id);
    const ids: string[] = [];
    host.addEventListener('zb:event', (e) => ids.push((e as CustomEvent).detail.instanceId));
    channel.emit('ready', { available: true });
    id = 'assigned-by-host';
    channel.emit('rendered', {});
    expect(ids).toEqual(['generated', 'assigned-by-host']);
  });

  it('passes well-formed host events to the listener and ignores malformed ones', () => {
    const got: Array<[string, unknown]> = [];
    const stop = new ExtensionChannel(host, () => 'i').onHostEvent((type, data) => got.push([type, data]));
    const send = (detail: unknown) => host.dispatchEvent(new CustomEvent('zb:host-event', { detail }));
    send({ type: 'cart.line-added', data: { lineId: 'L1' } });
    send('nonsense');
    send(null);
    send({ data: 1 }); // no type
    send({ type: 5 });
    expect(got).toEqual([['cart.line-added', { lineId: 'L1' }]]);
    stop();
    send({ type: 'cart.line-added' });
    expect(got).toHaveLength(1);
  });
});

describe('newInstanceId', () => {
  it('is a 32-char hex string, unique per call, and does not need a secure context', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const a = newInstanceId();
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(newInstanceId()).not.toBe(a);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
