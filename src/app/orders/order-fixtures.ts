/** Shared test data for the Orders specs (not part of the bundle: only specs import it). */
import type { ProductConfig } from '../customizer/models/product.models';
import type { MerchantCustomization, OrderDetail, OrderLine } from './order.models';

export const CONFIG = {
  schemaVersion: 2,
  id: 'cfg-mug',
  version: 3,
  status: 'published',
  product: { id: 'p', name: 'Mug' },
  variants: [{ id: 'v1', label: 'White', mockupIds: ['m1'], printableAreaIds: ['a1', 'a2'] }],
  mockups: [
    { id: 'm1', name: 'Front view', src: 'x', placements: [] },
    { id: 'm2', name: 'Front view', src: 'y', placements: [] },
  ],
  printableAreas: [
    { id: 'a1', name: 'Wrap', enabled: true, canvas: { width: 2000, height: 800 }, shape: { type: 'rect' }, artworkId: 'art1', artworkIds: ['art1'] },
    { id: 'a2', name: '../Handle', enabled: true, canvas: { width: 200, height: 200 }, shape: { type: 'rect' }, artworkId: 'art2', artworkIds: ['art2'] },
  ],
  artworks: [
    { id: 'art1', name: 'Photo wrap', printableAreaId: 'a1', layers: [] },
    { id: 'art2', name: 'Monogram', printableAreaId: 'a2', layers: [] },
  ],
  fonts: [{ id: 'f1', family: 'Inter', src: 'x', label: 'Inter Bold' }],
  fields: [
    { id: 'name', type: 'text', label: 'Your name', required: true, maxLength: 20, fontIds: ['f1'], colors: ['#112233'] },
    { id: 'photo', type: 'image', label: 'Your photo', required: true },
    { id: 'icon', type: 'artwork', label: 'Icon', required: false, choices: [{ id: 'c-star', label: 'Star', src: 'x' }] },
  ],
} as unknown as ProductConfig;

export const DATA = {
  schema: 1,
  template: { id: 'cfg-mug', version: 3 },
  customization: {
    schemaVersion: 2,
    productId: 'p',
    configId: 'cfg-mug',
    configVersion: 3,
    variantId: 'v1',
    artworkSelection: { a1: 'art1', a2: 'art2' },
    values: {
      icon: { choiceId: 'c-star' },
      name: { text: 'Ada', fontId: 'f1', color: '#112233', bold: true },
      photo: { assetId: 'local-1', crop: [0.1, 0.2, 0.5, 0.6], fit: 'cover', rotation: 90 },
      legacy: { text: 'kept', fontId: 'gone', color: '#000' },
    },
    areas: { a1: { artworkId: 'art1', canvas: { width: 2000, height: 800 } } },
    displayPrice: { currency: 'EUR', exponent: 2, baseMinor: 1500, customizationFeeMinor: 500, totalMinor: 2000, authoritative: false },
  },
  files: {
    uploads: [{ assetId: 'local-1', ref: 'up-1', mimeType: 'image/jpeg', width: 10, height: 10 }],
    artworks: [
      { printableAreaId: 'a1', artworkId: 'art1', width: 2000, height: 800, ref: 'art-1' },
      { printableAreaId: 'a2', artworkId: 'art2', width: 200, height: 200, ref: 'art-gone' },
    ],
    previews: [
      { mockupId: 'm1', ref: 'pre-1' },
      { mockupId: 'm2', ref: 'pre-2' },
    ],
  },
};

const asset = (assetId: string, kind: 'upload' | 'preview' | 'artwork', contentType = 'image/png', filename: string | null = null) => ({
  assetId, kind, contentType, sizeBytes: 10, width: 2000, height: 800, filename,
});

export const LINE: OrderLine = {
  lineId: 'L/1',
  productId: 'p',
  variantId: 'v1',
  quantity: 2,
  title: 'Mug',
  sku: 'MUG',
  unitPrice: '20.00',
  linkedAt: '2026-11-01T00:00:00.000Z',
  customization: { id: 'cz-1', status: 'ordered', configId: 'cfg-mug', configVersion: 3 },
  assets: [
    asset('art-1', 'artwork', 'image/png', 'a1'),
    asset('pre-1', 'preview', 'image/png', 'm1'),
    asset('pre-2', 'preview', 'image/png', 'm2'),
    asset('up-1', 'upload', 'image/jpeg', 'local-1'),
    asset('orphan', 'artwork', 'image/png', 'a9'),
  ],
};

export const ORDER: OrderDetail = {
  orderId: 'ORD/../1',
  orderNumber: '#1001',
  placedAt: '2026-11-01T00:00:00.000Z',
  currency: 'EUR',
  totals: { subtotal: null, shipping: null, tax: null, discount: null, total: '40.00' },
  customer: { id: null, name: 'Zelda Quill', email: 'z@example.test', phone: null },
  shippingAddress: { name: 'Zelda Quill', line1: '1 Road', line2: null, city: 'Lyon', region: null, postalCode: '69001', country: 'FR', phone: null },
  billingAddress: null,
  linkedAt: '2026-11-01T00:00:00.000Z',
  lines: [LINE],
};

export const CUSTOMIZATION: MerchantCustomization = {
  id: 'cz-1',
  status: 'ordered',
  configId: 'cfg-mug',
  configVersion: 3,
  productId: 'p',
  variantId: 'v1',
  data: DATA,
  createdAt: 0,
  orderedAt: '2026-11-01T00:00:00.000Z',
};
