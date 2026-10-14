// Test-only: shrink the 30 s save-acknowledgement timer (?ackScale=0.01 -> 300 ms) so timeout
// behaviour can be exercised quickly. The real constant is asserted in the unit tests.
{
  const scale = Number(new URLSearchParams(location.search).get('ackScale') || 1);
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) =>
    nativeSetTimeout(fn, ms === 30000 ? ms * scale : ms, ...args);
}

const params = new URLSearchParams(location.search);
const ENTRY = '/nested/path/customizer/product-customizer.js';

if (params.get('hostile')) {
  // Deliberately aggressive global CSS.
  document.getElementById('hostile').textContent = `
    * { font-family: "Comic Sans MS", cursive !important; color: #00ff00 !important; letter-spacing: 8px !important;
        line-height: 3 !important; text-transform: uppercase !important; text-align: right !important; word-spacing: 20px !important;
        white-space: pre !important; font-style: italic !important; font-weight: 900 !important; }
    div:not(#slots), p, label, button, input, select, canvas, section, form, fieldset, legend, span, li, ul, h2 {
      display: inline !important; margin: 30px !important; padding: 25px !important; border: 4px dashed red !important;
      width: 7px !important; height: 7px !important; position: fixed !important; box-sizing: content-box !important; }
    zb-product-customizer { display: block !important; width: auto !important; height: auto !important; position: static !important; }
  `;
}

const recorded = {}; // id -> summarised events
const saves = {}; // id -> full customizer-save details (with Blobs)

const summariseBlob = (b) => ({ size: b.size, type: b.type });
function summarise(type, detail) {
  if (type !== 'customizer-save') return detail;
  return {
    requestId: detail.requestId,
    customization: detail.customization,
    previewBlob: summariseBlob(detail.previewBlob),
    artworkBlob: summariseBlob(detail.artworkBlob),
    assets: detail.assets.map((a) => ({
      assetId: a.assetId,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      size: a.blob.size,
      blobType: a.blob.type,
    })),
  };
}

async function blobPixels(blob, points) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const out = {
    width: bitmap.width,
    height: bitmap.height,
    pixels: (points || []).map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)),
  };
  bitmap.close();
  return out;
}

window.testHost = {
  recorded,
  saves,
  async ready() {
    await customElements.whenDefined('zb-product-customizer');
  },
  async importAgain(url) {
    await import(url ?? ENTRY);
  },
  mount(id, props = {}, { attributes = {}, appendTo = '#slots', beforeAppend } = {}) {
    const el = document.createElement('zb-product-customizer');
    el.id = id;
    recorded[id] = [];
    saves[id] = [];
    for (const type of [
      'customizer-ready',
      'customizer-change',
      'customizer-save',
      'customizer-error',
    ]) {
      el.addEventListener(type, (event) => {
        recorded[id].push({ type, detail: summarise(type, event.detail), bubbles: event.bubbles });
        if (type === 'customizer-save') saves[id].push(event.detail);
      });
    }
    for (const [key, value] of Object.entries(props)) el[key] = value;
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    beforeAppend?.(el);
    document.querySelector(appendTo).append(el);
    return id;
  },
  remove(id) {
    document.getElementById(id)?.remove();
  },
  ack(id, result) {
    document.getElementById(id).saveResult = result;
  },
  set(id, prop, value) {
    document.getElementById(id)[prop] = value;
  },
  get(id, prop) {
    return document.getElementById(id)[prop];
  },
  status(id) {
    return document.getElementById(id)?.getAttribute('data-status');
  },
  saveState(id) {
    return document.getElementById(id)?.getAttribute('data-save-state');
  },
  events(id, type) {
    return recorded[id].filter((e) => !type || e.type === type);
  },
  /** Re-create an element from a saved design: a fresh element restored through properties. */
  remountFromSave(id, newId, props = {}) {
    const last = saves[id].at(-1);
    const assetMap = new Map(last.assets.map((a) => [a.assetId, a.blob]));
    this.mount(newId, { ...props, initialCustomization: last.customization, assetMap });
  },
  async pixels(id, which, points) {
    const detail = saves[id].at(-1);
    const blob =
      which === 'artwork'
        ? detail.artworkBlob
        : which === 'preview'
          ? detail.previewBlob
          : detail.assets[0].blob;
    return blobPixels(blob, points);
  },
  defined: () => !!customElements.get('zb-product-customizer'),
  shadow(id) {
    return document.getElementById(id).shadowRoot;
  },
};

if (params.get('import') !== 'none') await import(ENTRY);
window.testHostReady = true;
