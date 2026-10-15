/**
 * Configuration resolution: which mockups, printable areas, artworks and customer fields are active
 * for a variant + artwork selection + current values. Pure and deterministic; the same functions
 * serve the storefront, the merchant preview and the exporters.
 *
 *   variant -> mockups -> enabled areas -> artwork per area -> visible layers -> active fields
 */

import type { FieldSpec } from '../models/config.models';
import type { FieldValue } from '../models/draft.models';
import type {
  Artwork,
  ArtworkLayer,
  Condition,
  PrintableArea,
  ProductConfig,
  ProductMockup,
  ProductVariant,
} from '../models/product.models';
import { layerFieldId } from '../models/product.models';
import { DraftValues, isArtworkValue, isImageValue, isTextValue } from './values';

/** Printable area id -> chosen artwork id. Entries that are not valid options are ignored. */
export type ArtworkSelection = Readonly<Record<string, string>>;

export interface ResolvedArea {
  area: PrintableArea;
  /** The artwork actually shown (the selection, else the area default). */
  artwork: Artwork | null;
  /** Compatible artworks the customer may choose between (may be a single entry). */
  options: Artwork[];
  /** Visible layers of `artwork`, back to front. */
  layers: ArtworkLayer[];
}

export interface ResolvedProduct {
  variant: ProductVariant;
  /** Visible mockups that apply to the variant, in preview order. */
  mockups: ProductMockup[];
  /** Enabled areas that apply to the variant, in configuration order. */
  areas: ResolvedArea[];
}

export function resolveVariant(config: ProductConfig, variantId: string | null): ProductVariant {
  return config.variants.find((v) => v.id === variantId) ?? config.variants[0];
}

export function resolveProduct(
  config: ProductConfig,
  variantId: string | null,
  selection: ArtworkSelection = {},
): ResolvedProduct {
  const variant = resolveVariant(config, variantId);
  const assigned = variant.mockupIds
    .map((id) => config.mockups.find((m) => m.id === id))
    .filter((m): m is ProductMockup => !!m);
  // Hidden mockups are skipped, but a variant must never be left without any preview.
  const shown = assigned.filter((m) => m.visible !== false);
  const mockups = shown.length > 0 ? shown : assigned.slice(0, 1);

  const areaIds = new Set(variant.printableAreaIds);
  const areas: ResolvedArea[] = config.printableAreas
    .filter((area) => area.enabled && areaIds.has(area.id))
    .map((area) => {
      const options = area.artworkIds
        .map((id) => config.artworks.find((a) => a.id === id))
        .filter((a): a is Artwork => !!a);
      const chosen = options.find((a) => a.id === selection[area.id]);
      const artwork = chosen ?? options.find((a) => a.id === area.artworkId) ?? options[0] ?? null;
      return {
        area,
        artwork,
        options,
        layers: artwork ? artwork.layers.filter((layer) => layer.visible !== false) : [],
      };
    });
  return { variant, mockups, areas };
}

/**
 * The mockup to show: the requested one if it applies to the variant; otherwise the view with the
 * same name (so "Back" stays "Back" when the shopper changes colour), else the configured default,
 * else the first.
 */
export function pickMockup(
  config: ProductConfig,
  resolved: ResolvedProduct,
  requestedId: string | null,
): ProductMockup | null {
  const byId = (id: string | null | undefined) => resolved.mockups.find((m) => m.id === id);
  const requestedName = config.mockups.find((m) => m.id === requestedId)?.name;
  const byName = requestedName ? resolved.mockups.find((m) => m.name === requestedName) : undefined;
  return (
    byId(requestedId) ??
    byName ??
    byId(config.preview?.defaultMockupId) ??
    resolved.mockups[0] ??
    null
  );
}

// ---- conditions ---------------------------------------------------------------------------------

export interface ConditionContext {
  variantId: string;
  /** Artwork actually shown per active area. */
  artworkByArea: Readonly<Record<string, string>>;
  values: DraftValues;
}

export function evaluateCondition(condition: Condition, ctx: ConditionContext): boolean {
  switch (condition.op) {
    case 'artwork':
      return condition.printableAreaId
        ? ctx.artworkByArea[condition.printableAreaId] === condition.artworkId
        : Object.values(ctx.artworkByArea).includes(condition.artworkId);
    case 'variant':
      return condition.variantIds.includes(ctx.variantId);
    case 'field-equals': {
      const value = ctx.values[condition.fieldId];
      if (isTextValue(value)) return value.text === condition.value;
      if (isArtworkValue(value)) return value.choiceId === condition.value;
      return false;
    }
    case 'field-filled':
      return isFilled(ctx.values[condition.fieldId]);
    case 'all':
      return condition.conditions.every((c) => evaluateCondition(c, ctx));
    case 'any':
      return condition.conditions.some((c) => evaluateCondition(c, ctx));
    case 'not':
      return !evaluateCondition(condition.condition, ctx);
  }
}

function isFilled(value: FieldValue | undefined): boolean {
  if (isTextValue(value)) return value.text.trim().length > 0;
  if (isImageValue(value)) return value.assetId !== null;
  if (isArtworkValue(value)) return value.choiceId !== null;
  return false;
}

// ---- active fields -----------------------------------------------------------------------------

export interface FieldBinding {
  areaId: string;
  artworkId: string;
  layer: ArtworkLayer;
}

export interface ActiveField {
  field: FieldSpec;
  /** Active layers fed by this field (explicit `layer.fieldId` references), in area order. */
  bindings: FieldBinding[];
  /** False for `visible: false` fields: they keep their default value but have no input. */
  shown: boolean;
}

export interface FieldGroup {
  areaId: string;
  areaName: string;
  artwork: Artwork | null;
  options: Artwork[];
  fields: ActiveField[];
}

export function artworkByArea(resolved: ResolvedProduct): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { area, artwork } of resolved.areas) if (artwork) map[area.id] = artwork.id;
  return map;
}

/**
 * Fields fed by at least one active layer whose condition holds. Order follows `config.fields`, so
 * the form is stable. Values of fields that are not active stay in the draft but never render.
 */
export function activeFields(
  config: ProductConfig,
  resolved: ResolvedProduct,
  values: DraftValues,
): ActiveField[] {
  const bindings = new Map<string, FieldBinding[]>();
  for (const { area, artwork, layers } of resolved.areas) {
    if (!artwork) continue;
    for (const layer of layers) {
      const fieldId = layerFieldId(layer);
      if (fieldId === undefined) continue;
      const list = bindings.get(fieldId) ?? [];
      list.push({ areaId: area.id, artworkId: artwork.id, layer });
      bindings.set(fieldId, list);
    }
  }
  const ctx: ConditionContext = {
    variantId: resolved.variant.id,
    artworkByArea: artworkByArea(resolved),
    values,
  };
  const out: ActiveField[] = [];
  for (const field of config.fields) {
    const bound = bindings.get(field.id);
    if (!bound) continue;
    if (field.showWhen && !evaluateCondition(field.showWhen, ctx)) continue;
    out.push({ field, bindings: bound, shown: field.visible !== false });
  }
  return out;
}

/** Shown fields grouped under the first area that uses them; areas without fields still appear when they offer a choice. */
export function groupFields(
  resolved: ResolvedProduct,
  active: readonly ActiveField[],
): FieldGroup[] {
  const groups = new Map<string, FieldGroup>();
  for (const { area, artwork, options } of resolved.areas) {
    groups.set(area.id, {
      areaId: area.id,
      areaName: area.name,
      artwork,
      options,
      fields: [],
    });
  }
  for (const entry of active) {
    if (!entry.shown) continue;
    groups.get(entry.bindings[0].areaId)?.fields.push(entry);
  }
  return [...groups.values()].filter((g) => g.fields.length > 0 || g.options.length > 1);
}

/** Ids of every field some layer (visible or not, in any artwork) is bound to. */
export function boundFieldIds(config: ProductConfig): Set<string> {
  const ids = new Set<string>();
  for (const artwork of config.artworks) {
    for (const layer of artwork.layers) {
      const id = layerFieldId(layer);
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}
