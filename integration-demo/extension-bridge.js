/**
 * REFERENCE host bridge for the ZenBasket Extension Platform Contract v1 (storefront side).
 * See docs/extension-platform-contract-v1.md, sections 5 and 6.
 *
 * It is GENERIC on purpose: it contains no knowledge of any specific extension. What an extension may do
 * comes from its manifest (the `manifests` option); what it says arrives as `zb:event`. The platform's
 * storefront team can lift this file into the product details page and replace `manifests` with data
 * loaded from the plugin catalog.
 *
 * What it does
 *  1. Listens ONCE on the document for `zb:event` (extension events bubble and are composed).
 *  2. Validates every envelope and drops anything that is not from the extension the slot belongs to.
 *  3. Keeps per-instance state (`ready`, `gate`, `error`) so the page can collapse a slot or disable
 *     Add to cart.
 *  4. On Add to cart, asks every permitted instance to `prepareForCart()`, validates the values it
 *     returns against the manifest, and returns them as cart-line extensions
 *     `[{ extensionId, key, value }]` — the ONLY thing that goes onto the cart line.
 *  5. After the line is added, notifies the instances (`zb:host-event` `cart.line-added`).
 */

export const ZB_EVENT = 'zb:event';
export const ZB_HOST_EVENT = 'zb:host-event';
const PREPARE_TIMEOUT_MS = 30_000;
const LIMITS = { maxKeys: 8, maxKeyLength: 40, maxValueLength: 512 };

const isString = (v) => typeof v === 'string' && v.length > 0;

/**
 * @param {object} options
 * @param {Document|ShadowRoot} [options.root]   where to listen for events (default: document)
 * @param {Record<string, {tag: string, permissions: string[], lineExtensionKeys: string[]}>} options.manifests
 *        what each installed extension is allowed to do, keyed by extension id
 * @param {(state: InstanceState) => void} [options.onChange]  called whenever an instance's state changes
 */
export function createExtensionBridge({ root = document, manifests, onChange = () => {} }) {
  /** @type {Map<string, InstanceState>} */
  const instances = new Map();
  const keyOf = (extensionId, instanceId) => `${extensionId}/${instanceId}`;

  function accept(event) {
    const e = event.detail;
    if (!e || e.contract !== 1 || !isString(e.extensionId) || !isString(e.instanceId) || !isString(e.type)) return;
    const manifest = manifests[e.extensionId];
    if (!manifest) return; // not installed / unknown extension: ignore
    const element = event.target;
    // The element must be the tag this extension's manifest declares: an element cannot speak for another extension.
    if (!(element instanceof HTMLElement) || element.localName !== manifest.tag) return;

    const key = keyOf(e.extensionId, e.instanceId);
    const state =
      instances.get(key) ??
      { key, extensionId: e.extensionId, instanceId: e.instanceId, element, ready: null, gate: null, error: null, rendered: false };
    instances.set(key, state);
    switch (e.type) {
      case 'ready':
        state.ready = { available: e.data?.available !== false };
        break;
      case 'rendered':
        state.rendered = true;
        break;
      case 'gate':
        state.gate = { allowed: e.data?.allowed === true, reason: typeof e.data?.reason === 'string' ? e.data.reason : undefined };
        break;
      case 'error':
        state.error = { code: String(e.data?.code ?? 'unknown'), recoverable: e.data?.recoverable === true };
        break;
      default:
        // Custom types (`<extensionId>.<name>`) are for analytics/logging; the bridge never branches on them.
        break;
    }
    onChange(state);
  }
  root.addEventListener(ZB_EVENT, accept);

  const forgetRemoved = () => {
    for (const [key, state] of instances) if (!state.element.isConnected) instances.delete(key);
  };

  return {
    /** Current instances (removed elements are dropped). */
    instances() {
      forgetRemoved();
      return [...instances.values()];
    },

    /** True while any live instance says the primary action must stay disabled. */
    addToCartBlocked() {
      return this.instances().some((s) => s.ready?.available !== false && s.gate && !s.gate.allowed);
    },

    /** The first reason an instance gave for blocking Add to cart, for display. */
    blockedReason() {
      return this.instances().find((s) => s.gate && !s.gate.allowed)?.gate.reason ?? null;
    },

    /**
     * Asks every permitted, available instance to prepare for the cart. Resolves with the line
     * extensions to put on the cart line; REJECTS (with a message safe to show the shopper) if any
     * instance rejects or returns something the manifest does not allow — the add must then be cancelled.
     */
    async collectLineExtensions() {
      const lineExtensions = [];
      for (const state of this.instances()) {
        const manifest = manifests[state.extensionId];
        if (!manifest.permissions.includes('cart.line-extensions:write')) continue;
        if (state.ready?.available === false) continue; // the extension has nothing for this product
        // The bundle registers asynchronously; commands exist only once the element is defined.
        await customElements.whenDefined(manifest.tag);
        const values = await withTimeout(state.element.prepareForCart(), PREPARE_TIMEOUT_MS);
        const entries = Object.entries(values ?? {});
        if (entries.length > LIMITS.maxKeys) throw new Error('This add-on returned too much data.');
        for (const [key, value] of entries) {
          if (!manifest.lineExtensionKeys.includes(key) || key.length > LIMITS.maxKeyLength) {
            throw new Error('This add-on returned data it is not allowed to attach.');
          }
          if (typeof value !== 'string' || value.length > LIMITS.maxValueLength) {
            throw new Error('This add-on returned data that is too large.');
          }
          lineExtensions.push({ extensionId: state.extensionId, key, value });
        }
      }
      return lineExtensions;
    },

    /** Tell every instance the line exists, so it can drop state tied to one cart line. */
    notifyLineAdded(line) {
      for (const state of this.instances()) {
        state.element.dispatchEvent(new CustomEvent(ZB_HOST_EVENT, { detail: { type: 'cart.line-added', data: line } }));
      }
    },

    destroy() {
      root.removeEventListener(ZB_EVENT, accept);
      instances.clear();
    },
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Saving took too long. Please try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {object} InstanceState
 * @property {string} key
 * @property {string} extensionId
 * @property {string} instanceId
 * @property {HTMLElement & {prepareForCart(): Promise<Record<string,string>>}} element
 * @property {{available: boolean}|null} ready
 * @property {{allowed: boolean, reason?: string}|null} gate
 * @property {{code: string, recoverable: boolean}|null} error
 * @property {boolean} rendered
 */
