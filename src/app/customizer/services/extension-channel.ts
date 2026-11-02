import {
  PERSONALIZATION_EXTENSION_ID,
  STOREFRONT_PRODUCT_SLOT,
  ZB_CONTRACT_VERSION,
  ZB_EVENT,
  ZB_HOST_EVENT,
  type ZbEvent,
} from '../models/extension-contract';

/**
 * A random id for an element the host did not give an `instance-id`. Not `crypto.randomUUID()`: that
 * exists only in secure contexts, and an element on a plain-http page must not fail to construct.
 */
export function newInstanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The element's side of the extension contract: sends `zb:event` envelopes to the host and listens for
 * `zb:host-event` notifications. It is deliberately tiny and generic — it knows the envelope, never the
 * host. Events bubble and are composed, so one listener on `document` is enough for a host bridge.
 */
export class ExtensionChannel {
  constructor(
    private readonly host: HTMLElement,
    /** Read on every send, so a host-assigned `instance-id` attribute that arrives late is honoured. */
    private readonly instanceId: () => string,
    private readonly extensionId: string = PERSONALIZATION_EXTENSION_ID,
    private readonly slot: string = STOREFRONT_PRODUCT_SLOT,
  ) {}

  emit<T>(type: string, data: T): void {
    const detail: ZbEvent<T> = {
      contract: ZB_CONTRACT_VERSION,
      extensionId: this.extensionId,
      instanceId: this.instanceId(),
      slot: this.slot,
      type,
      data,
      ts: Date.now(),
    };
    this.host.dispatchEvent(new CustomEvent<ZbEvent<T>>(ZB_EVENT, { detail, bubbles: true, composed: true }));
  }

  /** Subscribes to host notifications; returns an unsubscribe function. Unknown shapes are ignored. */
  onHostEvent(listener: (type: string, data: unknown) => void): () => void {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== 'object' || detail === null) return;
      const type = (detail as { type?: unknown }).type;
      if (typeof type === 'string') listener(type, (detail as { data?: unknown }).data);
    };
    this.host.addEventListener(ZB_HOST_EVENT, handler);
    return () => this.host.removeEventListener(ZB_HOST_EVENT, handler);
  }
}
