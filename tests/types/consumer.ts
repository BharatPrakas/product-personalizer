/**
 * Compiled by `npm run test:types` against the declarations that ship in dist/product-personalization/types.
 * It is what a host application's TypeScript sees; `@ts-expect-error` lines must stay errors.
 */
import type {
  AdminErrorDetail,
  ConfigArchivedDetail,
  ConfigPublishedDetail,
  ConfigSavedDetail,
  CustomizerChangeDetail,
  CustomizerConfig,
  CustomizerErrorDetail,
  CustomizerSaveDetail,
  Customization,
  MappingChangedDetail,
  ProductMapping,
  ProductRef,
  SaveResult,
  ViewChangeDetail,
  ZbPersonalizationAdminElement,
  ZbProductCustomizerElement,
} from '../../dist/product-personalization/types/index';

// The tag name map is augmented globally, so createElement is typed.
const element = document.createElement('zb-product-customizer');
const same: ZbProductCustomizerElement = element;
void same;

// inputs
element.configUrl = '/customizer/data/tote.json';
element.baseUrl = 'https://cdn.example/customizer/';
element.config = null;
element.disabled = false;
element.allowedAssetOrigins = ['https://cdn.example'];
element.assetMap = new Map<string, string | Blob>([['asset-1', 'https://cdn.example/a.png']]);
element.assetMap = { 'asset-2': new Blob() };
const result: SaveResult = { requestId: 'r1', status: 'success', message: 'ok' };
element.saveResult = result;

// outputs: event names and detail types are checked
element.addEventListener('customizer-save', async (event) => {
  const detail: CustomizerSaveDetail = event.detail;
  const customization: Customization = detail.customization;
  const previewBytes: Blob = detail.previewBlob;
  const artworkBytes: Blob = detail.artworkBlob;
  const first = detail.assets[0];
  const dims: [number, number, string] = [first.width, first.height, first.mimeType];
  void [customization, previewBytes, artworkBytes, dims, await detail.artworkBlob.arrayBuffer()];
  element.saveResult = { requestId: detail.requestId, status: 'error', message: 'Unable to save.' };
});
element.addEventListener('customizer-change', (event) => {
  const detail: CustomizerChangeDetail = event.detail;
  const invalidIds: string[] = detail.errors.map((e) => e.fieldId);
  void [detail.valid, detail.dirty, invalidIds];
});
element.addEventListener('customizer-error', (event) => {
  const detail: CustomizerErrorDetail = event.detail;
  void [detail.code, detail.message, detail.recoverable, detail.fieldId];
});
element.addEventListener('customizer-ready', (event) => void event.detail.templateVersion);

// a typed configuration
const config: CustomizerConfig = {
  schemaVersion: 1,
  templateId: 't',
  templateVersion: 1,
  product: { id: 'p', name: 'Product' },
  canvas: { width: 100, height: 100, background: 'transparent' },
  mockup: { src: 'm.jpg', placement: { x: 0, y: 0, width: 1, height: 1 } },
  fonts: [{ id: 'f', family: 'F', src: 'f.woff2' }],
  fields: [
    {
      id: 'name',
      type: 'text',
      label: 'Name',
      required: true,
      maxLength: 10,
      fontIds: ['f'],
      colors: ['#000000'],
    },
  ],
  layers: [
    {
      id: 'l',
      type: 'text',
      fieldId: 'name',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      fontSize: 40,
      minFontSize: 10,
      align: 'center',
    },
  ],
};
element.config = config;

// ---- things that must NOT compile ----
// @ts-expect-error unknown property
element.nonsense = 1;
// @ts-expect-error status must be 'success' | 'error'
element.saveResult = { requestId: 'r', status: 'maybe' };
// @ts-expect-error disabled is a boolean
element.disabled = 'yes';
const bad: CustomizerConfig['fields'][number] = {
  id: 'x',
  // @ts-expect-error unknown field type
  type: 'video',
  label: 'x',
  required: true,
};
void bad;
element.addEventListener('customizer-save', (event) => {
  // @ts-expect-error requestId is a string
  const n: number = event.detail.requestId;
  void n;
});

// ---- storefront: resolve by product -------------------------------------------------------------
const resolving = document.createElement('zb-product-customizer');
resolving.productId = 'prod-1';
resolving.variantId = null;
resolving.collectionIds = ['summer', 'apparel'];
resolving.apiBaseUrl = 'https://api.example.com';
resolving.storeId = 'store-1';
resolving.addEventListener('customizer-ready', (event) => {
  // false: nothing is mapped, so the theme can hide the section
  const personalizable: boolean | undefined = event.detail.personalizable;
  void personalizable;
});
// @ts-expect-error productId is a string
resolving.productId = 42;
// @ts-expect-error collectionIds is a list of strings
resolving.collectionIds = 'a,b';

// ---- store admin element ----------------------------------------------------------------------------
const admin = document.createElement('zb-personalization-admin');
const sameAdmin: ZbPersonalizationAdminElement = admin;
void sameAdmin;
admin.apiBaseUrl = 'https://api.example.com';
admin.authToken = 'short-lived-session-token';
const products: ProductRef[] = [
  { id: 'p1', title: 'Tee', sku: 'T-1', variants: [{ id: 'v1', title: 'Small' }], collections: [{ id: 'c1', title: 'Summer' }] },
];
admin.productCatalog = products;
admin.productSearchUrl = '/catalog/search';
admin.view = 'mapping';
admin.configId = null;
admin.readonly = false;
admin.locale = 'fr';
admin.allowedAssetOrigins = ['https://cdn.example'];
admin.persistence = 'cloud';

admin.addEventListener('admin-ready', (event) => void [event.detail.version, event.detail.persistence]);
admin.addEventListener('view-change', (event) => {
  const detail: ViewChangeDetail = event.detail;
  void [detail.view, detail.configId];
});
admin.addEventListener('config-saved', (event) => {
  const detail: ConfigSavedDetail = event.detail;
  void [detail.configId, detail.name, detail.updatedAt];
});
admin.addEventListener('config-published', (event) => {
  const detail: ConfigPublishedDetail = event.detail;
  void [detail.version, detail.publishedAt];
});
admin.addEventListener('config-archived', (event) => {
  const detail: ConfigArchivedDetail = event.detail;
  void [detail.archived, detail.affectedMappings];
});
admin.addEventListener('mapping-changed', (event) => {
  const detail: MappingChangedDetail = event.detail;
  const mapping: ProductMapping | undefined = detail.mappings[0];
  void [detail.action, detail.deletedIds, mapping?.scope, mapping?.externalId];
});
admin.addEventListener('admin-error', (event) => {
  const detail: AdminErrorDetail = event.detail;
  void [detail.code, detail.message, detail.recoverable];
});

// @ts-expect-error unknown view
admin.view = 'dashboard';
// @ts-expect-error scope is product | variant | collection
const badMapping: ProductMapping['scope'] = 'sku';
void badMapping;
// @ts-expect-error persistence is local | cloud
admin.persistence = 'edge';
// @ts-expect-error unknown admin event detail field
admin.addEventListener('admin-error', (event) => void event.detail.stack);
