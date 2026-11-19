/**
 * Compiled by `npm run test:types` against the declarations that ship in dist/PRODUCT_PERSONALIZATION/types.
 * It is what a host application's TypeScript sees; `@ts-expect-error` lines must stay errors.
 */
import type {
  AdminErrorDetail,
  AreaPlacement,
  BezierPath,
  ConfigArchivedDetail,
  ConfigPublishedDetail,
  ConfigSavedDetail,
  CustomizerChangeDetail,
  CustomizerConfig,
  CustomizerErrorDetail,
  CustomizerSaveDetail,
  CylinderSurface,
  Customization,
  LineExtensionValues,
  MappingChangedDetail,
  MeshSpec,
  PlacementMask,
  PersonalizationSavedData,
  ProductMapping,
  ProductRef,
  SaveResult,
  ViewChangeDetail,
  ZbEvent,
  ZbRenderMode,
  ZbTriggerStyle,
  ZbStandardEventData,
  ZbPersonalizationAdminElement,
  ZbProductCustomizerElement,
} from '../../dist/PRODUCT_PERSONALIZATION/types/index';

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

// ---- storefront: rendering mode and the trigger button's Builder style -------------------------------
resolving.mode = 'storefront';
resolving.mode = 'preview';
resolving.mode = null;
const renderMode: ZbRenderMode = 'preview';
void renderMode;
// @ts-expect-error the modes are storefront | preview
resolving.mode = 'inline';

// The Builder's button model: names and px units as the Builder stores them.
const builderButton: ZbTriggerStyle = {
  buttonText: 'Personalize this product',
  buttonColor: '#0a5c36',
  buttonTextColor: '#ffffff',
  buttonFont: 'Georgia, serif',
  buttonTextSize: 18,
  buttonTextFontStyle: ['B', 'U'],
  buttonRadius: 24,
  borderRadiusPositions: ['TL', 'BR'],
  buttonPadding: 12,
  width: 'full',
  buttonAlignment: 'center',
  buttonBorderColor: '#112233',
  buttonBorderThickness: 2,
  buttonBorderPositions: ['T', 'B'],
  borderStyle: 'dashed',
  isButtonHoverEffect: true,
  buttonHoverColor: '#083d24',
  buttonDisabledColor: '#cccccc',
};
resolving.triggerStyle = builderButton;
resolving.triggerStyle = '{"buttonColor":"#0a5c36"}'; // the attribute form
resolving.triggerStyle = null;
// @ts-expect-error sizes are numbers (px), as in the Builder
const badSize: ZbTriggerStyle = { buttonTextSize: '18px' };
// @ts-expect-error the Builder says buttonColor, not backgroundColor
const badName: ZbTriggerStyle = { backgroundColor: '#000' };
void [badSize, badName];

// `personalization.saved` carries identifiers and metadata only.
resolving.addEventListener('zb:event', (event) => {
  if (event.detail.type !== 'personalization.saved') return;
  const saved = event.detail.data as PersonalizationSavedData;
  const ids: [string, string, number, string] = [saved.customizationId, saved.templateId, saved.templateVersion, saved.productId];
  const source: 'save' | 'cart' = saved.source;
  const image: string | undefined = saved.customizedImageUrl;
  void [ids, source, saved.variantId, saved.expiresAt, image];
  // @ts-expect-error no token or file bytes are part of the event
  void saved.accessToken;
});

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

// ---- Extension Platform Contract v1 -------------------------------------------------------------------

// `zb:event` is typed on the element, with the generic envelope.
element.addEventListener('zb:event', (event) => {
  const envelope: ZbEvent = event.detail;
  const id: string = envelope.instanceId;
  void id;
  if (envelope.type === 'gate') {
    const gate = envelope.data as ZbStandardEventData['gate'];
    const allowed: boolean = gate.allowed;
    void allowed;
  }
});

// context attributes as properties
element.instanceId = 'inst-1';
element.placement = 'product-detail';
element.hideSave = true;
// @ts-expect-error instanceId is a string or null
element.instanceId = 42;

// the host command resolves line extension values (string -> string), never arbitrary data
const values: Promise<LineExtensionValues> = element.prepareForCart();
void values;
void values.then((v) => {
  const customizationId: string | undefined = v['customizationId'];
  void customizationId;
  // @ts-expect-error values are read-only strings
  v['customizationId'] = 'x';
});

// Placement geometry (printable boundary, cylinder surface, mesh) is part of the public configuration types.
const outline: BezierPath = {
  version: 1,
  fillRule: 'evenodd',
  contours: [{ anchors: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1, handleOut: [0.95, 0.4], smooth: true }, { x: 0.5, y: 0.9 }] }],
};
const boundary: PlacementMask = { type: 'path', path: outline };
const paintedBoundary: PlacementMask = { type: 'raster', src: 'masks/label.png', width: 1000, height: 800 };
const cylinder: CylinderSurface = { type: 'cylinder', curvature: 140, centre: 0, visibleLeft: 90, visibleRight: 90, tilt: 0 };
const mesh: MeshSpec = { cols: 2, rows: 2, points: [0, 0, 1, 0, 0, 1, 1, 1] };
const placement: AreaPlacement = {
  printableAreaId: 'label',
  type: 'rect',
  x: 0.2,
  y: 0.3,
  width: 0.5,
  height: 0.3,
  mask: boundary,
  surface: cylinder,
  mesh,
};
void [paintedBoundary, placement];
// @ts-expect-error only a cylinder surface exists
const cone: CylinderSurface = { ...cylinder, type: 'cone' };
// @ts-expect-error a painted boundary needs the pixel size of its mask image
const sizeless: PlacementMask = { type: 'raster', src: 'masks/label.png' };
// @ts-expect-error the fill rule is one of two
const rule: BezierPath = { ...outline, fillRule: 'winding' };
void [cone, sizeless, rule];
