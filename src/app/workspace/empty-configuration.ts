import { PRODUCT_SCHEMA_VERSION, type ProductConfig } from '../customizer/models/product.models';

/**
 * A genuinely empty configuration: one variant and the bundled fonts, nothing else. The merchant
 * adds the mockup, printable areas, artwork and customer inputs.
 */
export function emptyConfiguration(id: string, name: string): ProductConfig {
  return {
    schemaVersion: PRODUCT_SCHEMA_VERSION,
    id,
    version: 1,
    status: 'draft',
    product: { id: `product-${id}`, name },
    assetBaseUrl: 'assets/',
    variants: [{ id: 'default', label: 'Default', mockupIds: [], printableAreaIds: [] }],
    mockups: [],
    printableAreas: [],
    artworks: [],
    fonts: [
      { id: 'sans', family: 'CustomizerSans', label: 'Sans', src: 'fonts/sans-regular.woff2' },
      {
        id: 'sans-bold',
        family: 'CustomizerSansBold',
        label: 'Sans bold',
        src: 'fonts/sans-bold.woff2',
      },
      {
        id: 'serif',
        family: 'CustomizerSerif',
        label: 'Serif bold',
        src: 'fonts/serif-bold.woff2',
      },
      { id: 'mono', family: 'CustomizerMono', label: 'Mono bold', src: 'fonts/mono-bold.woff2' },
    ],
    fields: [],
  };
}
