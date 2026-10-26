import type { ProductMapping } from './mapping.models';

/** What the storefront knows about the product page being viewed. */
export interface ResolveContext {
  productId: string;
  variantId?: string | null;
  collectionIds?: readonly string[] | null;
}

/**
 * Which mapping serves a product page. Precedence: a variant mapping wins over a product mapping,
 * which wins over a collection mapping; among several matching collections the lowest `externalId`
 * wins so the choice is deterministic. This mirrors the public storefront endpoint.
 */
export function resolveMapping(
  mappings: readonly ProductMapping[],
  context: ResolveContext,
): ProductMapping | null {
  const variant = context.variantId
    ? mappings.find((m) => m.scope === 'variant' && m.externalId === context.variantId)
    : undefined;
  if (variant) return variant;
  const product = mappings.find((m) => m.scope === 'product' && m.externalId === context.productId);
  if (product) return product;
  const collections = new Set(context.collectionIds ?? []);
  return (
    mappings
      .filter((m) => m.scope === 'collection' && collections.has(m.externalId))
      .sort((a, b) =>
        a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0,
      )[0] ?? null
  );
}

export type TargetStatus =
  | { kind: 'unmapped' }
  | { kind: 'mapped'; mapping: ProductMapping }
  | { kind: 'conflict'; mapping: ProductMapping };

/** Status of one target relative to the template being edited. */
export function statusFor(
  index: ReadonlyMap<string, ProductMapping>,
  scope: ProductMapping['scope'],
  externalId: string,
  configId: string,
): TargetStatus {
  const mapping = index.get(`${scope}:${externalId}`);
  if (!mapping) return { kind: 'unmapped' };
  return mapping.configId === configId
    ? { kind: 'mapped', mapping }
    : { kind: 'conflict', mapping };
}

export function indexMappings(mappings: readonly ProductMapping[]): Map<string, ProductMapping> {
  return new Map(mappings.map((m) => [`${m.scope}:${m.externalId}`, m]));
}
