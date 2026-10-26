// Test host for <zb-personalization-admin>. Mirrors host.js: records every event, assigns
// properties before the element is appended, and exposes helpers on window.adminHost.
const params = new URLSearchParams(location.search);
const ENTRY = '/nested/path/customizer/store-admin.js';

if (params.get('hostile')) {
  document.getElementById('hostile').textContent = `
    * { font-family: "Comic Sans MS", cursive !important; color: #00ff00 !important; letter-spacing: 8px !important;
        text-transform: uppercase !important; text-align: right !important; font-weight: 900 !important; }
    div, p, label, button, input, select, section, form, span, li, ul, h1, h2, table, td, th { display: inline !important;
      margin: 30px !important; padding: 25px !important; border: 4px dashed red !important; width: 7px !important;
      height: 7px !important; position: fixed !important; }
    zb-personalization-admin { display: block !important; width: auto !important; height: 760px !important; position: static !important; }
  `;
}

const recorded = {};
const TYPES = ['admin-ready', 'view-change', 'config-saved', 'config-published', 'config-archived', 'mapping-changed', 'admin-error'];

window.adminHost = {
  recorded,
  async importAgain(url) {
    await import(url ?? ENTRY);
  },
  mount(id, props = {}, { attributes = {} } = {}) {
    const el = document.createElement('zb-personalization-admin');
    el.id = id;
    el.style.height = '760px';
    recorded[id] = [];
    for (const type of TYPES) {
      el.addEventListener(type, (event) => {
        recorded[id].push({ type, detail: event.detail, bubbles: event.bubbles });
      });
    }
    for (const [key, value] of Object.entries(props)) el[key] = value;
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    document.getElementById('slots').append(el);
    return id;
  },
  remove(id) {
    document.getElementById(id)?.remove();
  },
  set(id, prop, value) {
    document.getElementById(id)[prop] = value;
  },
  get(id, prop) {
    return document.getElementById(id)[prop];
  },
  events(id, type) {
    return recorded[id].filter((e) => !type || e.type === type);
  },
  view(id) {
    return document.getElementById(id)?.getAttribute('data-view');
  },
  defined: () => !!customElements.get('zb-personalization-admin'),
};

if (params.get('import') !== 'none') await import(ENTRY);
window.testHostReady = true;
