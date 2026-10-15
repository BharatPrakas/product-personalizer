/**
 * Compatibility path: a validated schema-version-1 configuration becomes a one-variant,
 * one-mockup, one-area `ProductConfig`. Behaviour is preserved (single canvas, the same layer
 * order, the same field ids), so v1 hosts keep working unchanged.
 */

import { ConfigIssue, CustomizerConfig, LIMITS, PrintSpec } from '../models/config.models';
import {
  ArtworkLayer,
  PRODUCT_SCHEMA_VERSION,
  PrintableArea,
  ProductConfig,
} from '../models/product.models';

export const LEGACY_AREA_ID = 'main';
export const LEGACY_ARTWORK_ID = 'main-artwork';
export const LEGACY_MOCKUP_ID = 'main-mockup';
export const LEGACY_VARIANT_ID = 'default';

export function upgradeV1(config: CustomizerConfig): ProductConfig {
  const layers: ArtworkLayer[] = config.layers.map((layer): ArtworkLayer => {
    const box = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    switch (layer.type) {
      case 'image':
        return {
          id: layer.id,
          type: 'image-placeholder',
          fieldId: layer.fieldId,
          fit: 'cover',
          ...box,
        };
      case 'text':
        return {
          id: layer.id,
          type: 'text',
          fieldId: layer.fieldId,
          fontSize: layer.fontSize,
          minFontSize: layer.minFontSize,
          align: layer.align,
          ...box,
        };
      case 'artwork':
        return { id: layer.id, type: 'artwork', fieldId: layer.fieldId, ...box };
      case 'fixed-image':
        return { id: layer.id, type: 'fixed-image', src: layer.src, fit: 'contain', ...box };
    }
  });

  // v1 always blocked photos below 100 DPI once a physical size was configured.
  const print: PrintSpec | undefined = config.print
    ? { ...config.print, minDpi: Math.max(LIMITS.minDpiFloor, config.print.minDpi ?? 0) }
    : undefined;

  const area: PrintableArea = {
    id: LEGACY_AREA_ID,
    name: config.product.name,
    enabled: true,
    canvas: { ...config.canvas },
    shape: { type: 'rect' },
    ...(print ? { print } : {}),
    artworkId: LEGACY_ARTWORK_ID,
    artworkIds: [LEGACY_ARTWORK_ID],
  };

  return {
    schemaVersion: PRODUCT_SCHEMA_VERSION,
    id: config.templateId,
    version: config.templateVersion,
    status: 'published',
    product: { ...config.product },
    ...(config.assetBaseUrl ? { assetBaseUrl: config.assetBaseUrl } : {}),
    variants: [
      {
        id: config.product.variantId ?? LEGACY_VARIANT_ID,
        label: config.product.name,
        mockupIds: [LEGACY_MOCKUP_ID],
        printableAreaIds: [LEGACY_AREA_ID],
      },
    ],
    mockups: [
      {
        id: LEGACY_MOCKUP_ID,
        name: 'Product',
        src: config.mockup.src,
        placements: [{ printableAreaId: LEGACY_AREA_ID, type: 'rect', ...config.mockup.placement }],
      },
    ],
    printableAreas: [area],
    artworks: [
      { id: LEGACY_ARTWORK_ID, name: config.product.name, printableAreaId: LEGACY_AREA_ID, layers },
    ],
    fonts: config.fonts.map((font) => ({ ...font })),
    fields: structuredClone(config.fields),
    ...(config.displayPrice ? { displayPrice: { ...config.displayPrice } } : {}),
  };
}

/**
 * Version 1 stretched nothing: a placement whose pixel aspect ratio differs from the canvas was
 * rejected once the mockup size was known. Applied only to configurations that came from v1.
 */
export function checkLegacyGeometry(
  config: ProductConfig,
  mockupWidth: number,
  mockupHeight: number,
): ConfigIssue | null {
  const area = config.printableAreas[0];
  const placement = config.mockups[0]?.placements[0];
  if (!area || !placement) return null;
  const placementAspect = (placement.width * mockupWidth) / (placement.height * mockupHeight);
  const canvasAspect = area.canvas.width / area.canvas.height;
  if (Math.abs(placementAspect - canvasAspect) / canvasAspect > 0.01) {
    return {
      path: 'mockup.placement',
      code: 'mockup-aspect-mismatch',
      message:
        `placement is ${placementAspect.toFixed(3)}:1 on the ${mockupWidth}x${mockupHeight} mockup ` +
        `but the canvas is ${canvasAspect.toFixed(3)}:1; the artwork would be stretched`,
    };
  }
  return null;
}
