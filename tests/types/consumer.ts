/**
 * Compiled by `npm run test:types` against the declarations that ship in dist/element/types.
 * It is what a host application's TypeScript sees; `@ts-expect-error` lines must stay errors.
 */
import type {
  CustomizerChangeDetail,
  CustomizerConfig,
  CustomizerErrorDetail,
  CustomizerSaveDetail,
  Customization,
  SaveResult,
  ZbProductCustomizerElement,
} from '../../dist/element/types/index';

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
