/**
 * Immutable edit operations on a `ProductConfig`. Every function returns a new configuration (or
 * the same one when the edit is not allowed), so undo / redo is just keeping the previous objects.
 *
 * Rules these operations keep, so an edited configuration stays valid:
 *  - ids are unique and generated, never derived from labels or positions;
 *  - an editable layer always points at an existing field of the right type (`layer.fieldId`);
 *  - fields exist only while at least one layer uses them (orphans are pruned);
 *  - removing an area / artwork / mockup / variant removes every reference to it.
 */

import { FieldSpec, FontSpec, ImageFieldSpec, TextFieldSpec } from '../../customizer/models/config.models';
import {
  AreaPlacement,
  Artwork,
  ArtworkLayer,
  DEFAULT_AREA_BOUNDARY,
  MockupOverlay,
  PrintableArea,
  ProductConfig,
  ProductMockup,
  ProductVariant,
  ShapeSpec,
  TextLayer,
  layerFieldId,
} from '../../customizer/models/product.models';
import { boundFieldIds } from '../../customizer/util/resolve';

// ---- ids --------------------------------------------------------------------------------------

export function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'item';
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = slug(base);
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function allLayerIds(config: ProductConfig): string[] {
  return config.artworks.flatMap((a) => a.layers.map((l) => l.id));
}

/** Shallow merge that deletes keys set to `undefined`, so saved JSON never carries them. */
function merge<T extends object>(target: T, patch: object): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as T;
}

// ---- product & variants -------------------------------------------------------------------------

export function patchProduct(
  config: ProductConfig,
  patch: Partial<Pick<ProductConfig, 'status'>> & { name?: string; productId?: string },
): ProductConfig {
  return {
    ...config,
    ...(patch.status ? { status: patch.status } : {}),
    product: {
      ...config.product,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.productId !== undefined ? { id: patch.productId } : {}),
    },
  };
}

export function addVariant(
  config: ProductConfig,
  label: string,
): { config: ProductConfig; id: string } {
  const first = config.variants[0];
  const id = uniqueId(
    label,
    config.variants.map((v) => v.id),
  );
  const variant: ProductVariant = {
    id,
    label,
    mockupIds: [...first.mockupIds],
    printableAreaIds: [...first.printableAreaIds],
  };
  return { config: { ...config, variants: [...config.variants, variant] }, id };
}

export function updateVariant(
  config: ProductConfig,
  id: string,
  patch: Partial<Pick<ProductVariant, 'label' | 'swatch'>>,
): ProductConfig {
  return { ...config, variants: config.variants.map((v) => (v.id === id ? merge(v, patch) : v)) };
}

export function removeVariant(config: ProductConfig, id: string): ProductConfig {
  if (config.variants.length <= 1) return config;
  return pruneConditions({ ...config, variants: config.variants.filter((v) => v.id !== id) });
}

function orderedByMockups(config: ProductConfig, ids: string[]): string[] {
  const order = new Map(config.mockups.map((m, i) => [m.id, i]));
  return [...new Set(ids)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

export function toggleVariantMockup(
  config: ProductConfig,
  variantId: string,
  mockupId: string,
  on: boolean,
): ProductConfig {
  return {
    ...config,
    variants: config.variants.map((v) => {
      if (v.id !== variantId) return v;
      const ids = on ? [...v.mockupIds, mockupId] : v.mockupIds.filter((id) => id !== mockupId);
      // A variant with no mockup is allowed while drafting; publishing requires one.
      return { ...v, mockupIds: orderedByMockups(config, ids) };
    }),
  };
}

export function toggleVariantArea(
  config: ProductConfig,
  variantId: string,
  areaId: string,
  on: boolean,
): ProductConfig {
  const order = new Map(config.printableAreas.map((a, i) => [a.id, i]));
  return {
    ...config,
    variants: config.variants.map((v) => {
      if (v.id !== variantId) return v;
      const ids = on
        ? [...new Set([...v.printableAreaIds, areaId])]
        : v.printableAreaIds.filter((id) => id !== areaId);
      return {
        ...v,
        printableAreaIds: ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
      };
    }),
  };
}

// ---- mockups --------------------------------------------------------------------------------------

export function addMockup(
  config: ProductConfig,
  input: { name: string; src: string; variantIds?: string[] },
): { config: ProductConfig; id: string } {
  const id = uniqueId(
    input.name,
    config.mockups.map((m) => m.id),
  );
  const mockup: ProductMockup = { id, name: input.name, src: input.src, placements: [] };
  const targets = new Set(input.variantIds ?? config.variants.map((v) => v.id));
  const next: ProductConfig = {
    ...config,
    mockups: [...config.mockups, mockup],
    variants: config.variants.map((v) =>
      targets.has(v.id) ? { ...v, mockupIds: [...v.mockupIds, id] } : v,
    ),
  };
  return { config: next, id };
}

export function updateMockup(
  config: ProductConfig,
  id: string,
  patch: Partial<Pick<ProductMockup, 'name' | 'src' | 'visible' | 'thumbnail'>>,
): ProductConfig {
  return { ...config, mockups: config.mockups.map((m) => (m.id === id ? merge(m, patch) : m)) };
}

export function removeMockup(config: ProductConfig, id: string): ProductConfig {
  const mockups = config.mockups.filter((m) => m.id !== id);
  const preview =
    config.preview?.defaultMockupId === id
      ? merge(config.preview, { defaultMockupId: undefined })
      : config.preview;
  return {
    ...config,
    mockups,
    variants: config.variants.map((v) => {
      return { ...v, mockupIds: v.mockupIds.filter((m) => m !== id) };
    }),
    ...(preview ? { preview } : {}),
  };
}

export function moveMockup(config: ProductConfig, id: string, direction: -1 | 1): ProductConfig {
  const index = config.mockups.findIndex((m) => m.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= config.mockups.length) return config;
  const mockups = [...config.mockups];
  [mockups[index], mockups[target]] = [mockups[target], mockups[index]];
  const next = { ...config, mockups };
  return {
    ...next,
    variants: next.variants.map((v) => ({ ...v, mockupIds: orderedByMockups(next, v.mockupIds) })),
  };
}

export function setDefaultMockup(config: ProductConfig, id: string | undefined): ProductConfig {
  return { ...config, preview: merge(config.preview ?? {}, { defaultMockupId: id }) };
}

export function addOverlay(config: ProductConfig, mockupId: string, src: string): ProductConfig {
  return {
    ...config,
    mockups: config.mockups.map((m) => {
      if (m.id !== mockupId) return m;
      const id = uniqueId(
        'overlay',
        (m.overlays ?? []).map((o) => o.id),
      );
      return { ...m, overlays: [...(m.overlays ?? []), { id, src }] };
    }),
  };
}

export function updateOverlay(
  config: ProductConfig,
  mockupId: string,
  overlayId: string,
  patch: Partial<MockupOverlay>,
): ProductConfig {
  return {
    ...config,
    mockups: config.mockups.map((m) =>
      m.id === mockupId
        ? {
            ...m,
            overlays: (m.overlays ?? []).map((o) => (o.id === overlayId ? merge(o, patch) : o)),
          }
        : m,
    ),
  };
}

export function removeOverlay(
  config: ProductConfig,
  mockupId: string,
  overlayId: string,
): ProductConfig {
  return {
    ...config,
    mockups: config.mockups.map((m) => {
      if (m.id !== mockupId) return m;
      const overlays = (m.overlays ?? []).filter((o) => o.id !== overlayId);
      const { overlays: _drop, ...rest } = m;
      void _drop;
      return overlays.length > 0 ? { ...rest, overlays } : rest;
    }),
  };
}

// ---- placements -----------------------------------------------------------------------------------

/** A centred placement about 34% of the mockup wide whose pixel aspect matches the area canvas. */
export function defaultPlacement(
  area: PrintableArea,
  mockupWidth: number,
  mockupHeight: number,
  offset = 0,
): AreaPlacement {
  const aspect = area.canvas.width / area.canvas.height;
  let w = 0.34 * mockupWidth;
  let h = w / aspect;
  if (h > 0.6 * mockupHeight) {
    h = 0.6 * mockupHeight;
    w = h * aspect;
  }
  return {
    printableAreaId: area.id,
    type: 'rect',
    x: Math.min(0.9, Math.max(0, 0.5 - w / mockupWidth / 2 + offset)),
    y: Math.min(0.9, Math.max(0, 0.5 - h / mockupHeight / 2 + offset)),
    width: w / mockupWidth,
    height: h / mockupHeight,
  };
}

export function setPlacement(
  config: ProductConfig,
  mockupId: string,
  placement: AreaPlacement | null,
  areaId: string = placement?.printableAreaId ?? '',
): ProductConfig {
  return {
    ...config,
    mockups: config.mockups.map((m) => {
      if (m.id !== mockupId) return m;
      const rest = m.placements.filter((p) => p.printableAreaId !== areaId);
      if (!placement) return { ...m, placements: rest };
      const index = m.placements.findIndex((p) => p.printableAreaId === areaId);
      const placements = [...m.placements];
      if (index >= 0) placements[index] = placement;
      else placements.push(placement);
      return { ...m, placements };
    }),
  };
}

export function updatePlacement(
  config: ProductConfig,
  mockupId: string,
  areaId: string,
  patch: Partial<AreaPlacement>,
): ProductConfig {
  return {
    ...config,
    mockups: config.mockups.map((m) =>
      m.id === mockupId
        ? {
            ...m,
            placements: m.placements.map((p) =>
              p.printableAreaId === areaId ? merge(p, patch) : p,
            ),
          }
        : m,
    ),
  };
}

// ---- printable areas ------------------------------------------------------------------------------

export interface NewAreaInput {
  name: string;
  shape: ShapeSpec;
  canvasWidth: number;
  canvasHeight: number;
  /** Mockup the new area is placed on (also decides which variants get the area). */
  mockupId?: string;
  placement?: Omit<AreaPlacement, 'printableAreaId'>;
}

export function addArea(
  config: ProductConfig,
  input: NewAreaInput,
): { config: ProductConfig; areaId: string; artworkId: string } {
  const areaId = uniqueId(
    input.name,
    config.printableAreas.map((a) => a.id),
  );
  const artworkId = uniqueId(
    `${input.name} artwork`,
    config.artworks.map((a) => a.id),
  );
  const area: PrintableArea = {
    id: areaId,
    name: input.name,
    enabled: true,
    canvas: { width: input.canvasWidth, height: input.canvasHeight, background: 'transparent' },
    shape: input.shape,
    artworkId,
    artworkIds: [artworkId],
    boundary: { ...DEFAULT_AREA_BOUNDARY },
  };
  const artwork: Artwork = {
    id: artworkId,
    name: `${input.name} artwork`,
    printableAreaId: areaId,
    layers: [],
  };
  let next: ProductConfig = {
    ...config,
    printableAreas: [...config.printableAreas, area],
    artworks: [...config.artworks, artwork],
    variants: config.variants.map((v) =>
      !input.mockupId || v.mockupIds.includes(input.mockupId)
        ? { ...v, printableAreaIds: [...v.printableAreaIds, areaId] }
        : v,
    ),
  };
  if (input.mockupId && input.placement) {
    next = setPlacement(next, input.mockupId, { ...input.placement, printableAreaId: areaId });
  }
  return { config: next, areaId, artworkId };
}

export function updateArea(
  config: ProductConfig,
  id: string,
  patch: Partial<Omit<PrintableArea, 'id'>>,
): ProductConfig {
  return {
    ...config,
    printableAreas: config.printableAreas.map((a) => (a.id === id ? merge(a, patch) : a)),
  };
}

export function removeArea(config: ProductConfig, id: string): ProductConfig {
  const dropped = new Set(config.artworks.filter((a) => a.printableAreaId === id).map((a) => a.id));
  // A variant left without an area is moved onto another one; removing the last area leaves it empty.
  const fallbackId = config.printableAreas.find((a) => a.id !== id)?.id;
  return pruneConditions(
    pruneOrphanFields({
      ...config,
      printableAreas: config.printableAreas.filter((a) => a.id !== id),
      artworks: config.artworks.filter((a) => !dropped.has(a.id)),
      mockups: config.mockups.map((m) => ({
        ...m,
        placements: m.placements.filter((p) => p.printableAreaId !== id),
      })),
      variants: config.variants.map((v) => {
        const ids = v.printableAreaIds.filter((a) => a !== id);
        return {
          ...v,
          printableAreaIds: ids.length > 0 || fallbackId === undefined ? ids : [fallbackId],
        };
      }),
    }),
  );
}

/** Copy an area with its artworks, new customer fields and its placements (nudged so they are visible). */
export function duplicateArea(
  config: ProductConfig,
  id: string,
): { config: ProductConfig; areaId: string } | null {
  const source = config.printableAreas.find((a) => a.id === id);
  if (!source) return null;
  const areaId = uniqueId(
    `${source.name} copy`,
    config.printableAreas.map((a) => a.id),
  );
  const fieldIds = new Set(config.fields.map((f) => f.id));
  const layerIds = new Set(allLayerIds(config));
  const artworkIds = new Set(config.artworks.map((a) => a.id));
  const fieldMap = new Map<string, string>();
  const newFields: FieldSpec[] = [];
  const artworkMap = new Map<string, string>();

  const newArtworks = config.artworks
    .filter((a) => a.printableAreaId === id)
    .map((artwork): Artwork => {
      const newId = uniqueId(`${artwork.name} copy`, artworkIds);
      artworkIds.add(newId);
      artworkMap.set(artwork.id, newId);
      const layers = artwork.layers.map((layer): ArtworkLayer => {
        const copy = structuredClone(layer);
        copy.id = uniqueId(layer.id, layerIds);
        layerIds.add(copy.id);
        const fieldId = layerFieldId(layer);
        if (fieldId !== undefined && 'fieldId' in copy) {
          let mapped = fieldMap.get(fieldId);
          if (!mapped) {
            const field = config.fields.find((f) => f.id === fieldId);
            if (field) {
              mapped = uniqueId(`${field.id} copy`, fieldIds);
              fieldIds.add(mapped);
              fieldMap.set(fieldId, mapped);
              newFields.push({
                ...structuredClone(field),
                id: mapped,
                label: `${field.label} (copy)`.slice(0, 80),
                printableAreaId: areaId,
                ...(field.artworkId ? { artworkId: newId } : {}),
                showWhen: undefined,
              } as FieldSpec);
            }
          }
          if (mapped) (copy as { fieldId: string }).fieldId = mapped;
        }
        return copy;
      });
      return {
        ...structuredClone(artwork),
        id: newId,
        name: `${artwork.name} copy`,
        printableAreaId: areaId,
        layers,
      };
    });
  for (const field of newFields)
    if (field.showWhen === undefined) delete (field as { showWhen?: unknown }).showWhen;

  const area: PrintableArea = {
    ...structuredClone(source),
    id: areaId,
    name: `${source.name} copy`,
    artworkId: artworkMap.get(source.artworkId) ?? newArtworks[0]?.id ?? source.artworkId,
    artworkIds: source.artworkIds.map((a) => artworkMap.get(a) ?? a),
  };
  const next: ProductConfig = {
    ...config,
    printableAreas: [...config.printableAreas, area],
    artworks: [...config.artworks, ...newArtworks],
    fields: [...config.fields, ...newFields],
    mockups: config.mockups.map((m) => {
      const original = m.placements.find((p) => p.printableAreaId === id);
      if (!original) return m;
      const copy: AreaPlacement = { ...structuredClone(original), printableAreaId: areaId };
      copy.x = Math.min(0.95, original.x + 0.04);
      copy.y = Math.min(0.95, original.y + 0.04);
      if (copy.corners)
        copy.corners = copy.corners.map(([x, y]) => [
          x + 0.04,
          y + 0.04,
        ]) as unknown as AreaPlacement['corners'];
      return { ...m, placements: [...m.placements, copy] };
    }),
    variants: config.variants.map((v) =>
      v.printableAreaIds.includes(id)
        ? { ...v, printableAreaIds: [...v.printableAreaIds, areaId] }
        : v,
    ),
  };
  return { config: next, areaId };
}

// ---- artworks ---------------------------------------------------------------------------------------

export function addArtwork(
  config: ProductConfig,
  areaId: string,
  name: string,
): { config: ProductConfig; id: string } {
  const id = uniqueId(
    name,
    config.artworks.map((a) => a.id),
  );
  const artwork: Artwork = { id, name, printableAreaId: areaId, layers: [] };
  return {
    config: {
      ...config,
      artworks: [...config.artworks, artwork],
      printableAreas: config.printableAreas.map((a) =>
        a.id === areaId ? { ...a, artworkIds: [...a.artworkIds, id] } : a,
      ),
    },
    id,
  };
}

export function updateArtwork(
  config: ProductConfig,
  id: string,
  patch: Partial<Pick<Artwork, 'name' | 'background'>>,
): ProductConfig {
  return { ...config, artworks: config.artworks.map((a) => (a.id === id ? merge(a, patch) : a)) };
}

export function setDefaultArtwork(
  config: ProductConfig,
  areaId: string,
  artworkId: string,
): ProductConfig {
  return updateArea(config, areaId, { artworkId });
}

export function removeArtwork(config: ProductConfig, id: string): ProductConfig {
  const artwork = config.artworks.find((a) => a.id === id);
  const area = config.printableAreas.find((a) => a.id === artwork?.printableAreaId);
  if (!artwork || !area || area.artworkIds.length <= 1) return config;
  const remaining = area.artworkIds.filter((a) => a !== id);
  return pruneConditions(
    pruneOrphanFields({
      ...config,
      artworks: config.artworks.filter((a) => a.id !== id),
      printableAreas: config.printableAreas.map((a) =>
        a.id === area.id
          ? {
              ...a,
              artworkIds: remaining,
              artworkId: a.artworkId === id ? remaining[0] : a.artworkId,
            }
          : a,
      ),
    }),
  );
}

// ---- layers -------------------------------------------------------------------------------------------

export type NewLayerKind =
  | 'fixed-image'
  | 'image-placeholder'
  | 'text-editable'
  | 'text-fixed'
  | 'artwork-choice'
  | 'shape-rect'
  | 'shape-ellipse';

export const CLIPART_CHOICES = [
  ['star', 'Star'],
  ['heart', 'Heart'],
  ['moon', 'Moon'],
  ['sun', 'Sun'],
  ['leaf', 'Leaf'],
  ['paw', 'Paw'],
] as const;

export const DEFAULT_INKS = ['#111827', '#c2185b', '#296fd7', '#ffffff'];

export function addLayer(
  config: ProductConfig,
  artworkId: string,
  kind: NewLayerKind,
  options: { src?: string } = {},
): { config: ProductConfig; layerId: string; fieldId?: string } | null {
  const artwork = config.artworks.find((a) => a.id === artworkId);
  const area = config.printableAreas.find((a) => a.id === artwork?.printableAreaId);
  if (!artwork || !area) return null;
  const { width: cw, height: ch } = area.canvas;
  const size = Math.round(Math.min(cw, ch) * 0.4);
  const layerId = uniqueId(kind.replace('-', ' '), allLayerIds(config));
  const box = (w: number, h: number) => ({
    x: Math.round((cw - w) / 2),
    y: Math.round((ch - h) / 2),
    width: Math.round(w),
    height: Math.round(h),
  });
  const fields = [...config.fields];
  let layer: ArtworkLayer;
  let fieldId: string | undefined;

  const scope = { printableAreaId: area.id, artworkId: artwork.id };
  switch (kind) {
    case 'fixed-image':
      layer = {
        id: layerId,
        type: 'fixed-image',
        name: 'Image',
        src: options.src ?? '',
        fit: 'contain',
        ...box(size, size),
      };
      break;
    case 'image-placeholder': {
      const count = fields.filter((f) => f.type === 'image').length + 1;
      fieldId = uniqueId(
        `photo ${count}`,
        fields.map((f) => f.id),
      );
      const field: ImageFieldSpec = {
        id: fieldId,
        type: 'image',
        label: `Photo ${count}`,
        required: true,
        accept: ['image/png', 'image/jpeg'],
        ...scope,
      };
      fields.push(field);
      layer = {
        id: layerId,
        type: 'image-placeholder',
        name: `Photo ${count}`,
        fieldId,
        fit: 'cover',
        ...box(size, size),
      };
      break;
    }
    case 'text-editable': {
      const count = fields.filter((f) => f.type === 'text').length + 1;
      fieldId = uniqueId(
        `text ${count}`,
        fields.map((f) => f.id),
      );
      const field: TextFieldSpec = {
        id: fieldId,
        type: 'text',
        label: `Text ${count}`,
        required: false,
        maxLength: 24,
        fontIds: config.fonts.map((f) => f.id),
        colors: DEFAULT_INKS,
        defaultValue: { text: '', fontId: config.fonts[0].id, color: DEFAULT_INKS[0] },
        placeholder: 'Your text',
        styleControls: ['bold', 'italic'],
        ...scope,
      };
      fields.push(field);
      layer = {
        id: layerId,
        type: 'text',
        name: `Text ${count}`,
        fieldId,
        fontSize: Math.round(ch * 0.08),
        minFontSize: Math.round(ch * 0.03),
        align: 'center',
        ...box(cw * 0.7, ch * 0.14),
      };
      break;
    }
    case 'text-fixed':
      layer = {
        id: layerId,
        type: 'text',
        name: 'Fixed text',
        text: 'Your text here',
        fontId: config.fonts[0].id,
        color: DEFAULT_INKS[0],
        fontSize: Math.round(ch * 0.07),
        minFontSize: Math.round(ch * 0.03),
        align: 'center',
        ...box(cw * 0.7, ch * 0.12),
      };
      break;
    case 'artwork-choice': {
      const count = fields.filter((f) => f.type === 'artwork').length + 1;
      fieldId = uniqueId(
        `motif ${count}`,
        fields.map((f) => f.id),
      );
      fields.push({
        id: fieldId,
        type: 'artwork',
        label: `Motif ${count}`,
        required: false,
        choices: CLIPART_CHOICES.map(([id, label]) => ({ id, label, src: `clipart/${id}.png` })),
        defaultChoiceId: 'star',
        ...scope,
      });
      layer = {
        id: layerId,
        type: 'artwork',
        name: `Motif ${count}`,
        fieldId,
        ...box(size * 0.6, size * 0.6),
      };
      break;
    }
    case 'shape-rect':
    case 'shape-ellipse':
      layer = {
        id: layerId,
        type: 'shape',
        name: kind === 'shape-rect' ? 'Rectangle' : 'Ellipse',
        shape: kind === 'shape-rect' ? { type: 'rect' } : { type: 'ellipse' },
        fill: '#fde68a',
        stroke: '#92400e',
        strokeWidth: Math.max(2, Math.round(Math.min(cw, ch) * 0.006)),
        ...box(size, size * 0.7),
      };
      break;
  }
  return {
    config: {
      ...config,
      fields,
      artworks: config.artworks.map((a) =>
        a.id === artworkId ? { ...a, layers: [...a.layers, layer] } : a,
      ),
    },
    layerId,
    fieldId,
  };
}

export function updateLayer(
  config: ProductConfig,
  layerId: string,
  patch: Record<string, unknown>,
): ProductConfig {
  return {
    ...config,
    artworks: config.artworks.map((a) =>
      a.layers.some((l) => l.id === layerId)
        ? {
            ...a,
            layers: a.layers.map((l) =>
              l.id === layerId ? (merge(l as object, patch) as ArtworkLayer) : l,
            ),
          }
        : a,
    ),
  };
}

export function removeLayer(config: ProductConfig, layerId: string): ProductConfig {
  return pruneOrphanFields({
    ...config,
    artworks: config.artworks.map((a) => ({
      ...a,
      layers: a.layers.filter((l) => l.id !== layerId),
    })),
  });
}

export function moveLayer(
  config: ProductConfig,
  layerId: string,
  to: 'front' | 'forward' | 'backward' | 'back',
): ProductConfig {
  return {
    ...config,
    artworks: config.artworks.map((a) => {
      const index = a.layers.findIndex((l) => l.id === layerId);
      if (index < 0) return a;
      const layers = [...a.layers];
      const [layer] = layers.splice(index, 1);
      const target =
        to === 'front'
          ? layers.length
          : to === 'back'
            ? 0
            : to === 'forward'
              ? index + 1
              : index - 1;
      layers.splice(Math.max(0, Math.min(layers.length, target)), 0, layer);
      return { ...a, layers };
    }),
  };
}

/** Move a layer to `toIndex` in the stack (0 = back). Used by drag-and-drop ordering. */
export function reorderLayer(
  config: ProductConfig,
  layerId: string,
  toIndex: number,
): ProductConfig {
  return {
    ...config,
    artworks: config.artworks.map((a) => {
      const index = a.layers.findIndex((l) => l.id === layerId);
      if (index < 0 || index === toIndex) return a;
      const layers = [...a.layers];
      const [layer] = layers.splice(index, 1);
      layers.splice(Math.max(0, Math.min(layers.length, toIndex)), 0, layer);
      return { ...a, layers };
    }),
  };
}

export function duplicateLayer(
  config: ProductConfig,
  layerId: string,
): { config: ProductConfig; layerId: string } | null {
  const artwork = config.artworks.find((a) => a.layers.some((l) => l.id === layerId));
  const source = artwork?.layers.find((l) => l.id === layerId);
  if (!artwork || !source) return null;
  const copy = structuredClone(source);
  copy.id = uniqueId(source.id, allLayerIds(config));
  copy.name = `${source.name ?? source.type} copy`.slice(0, 80);
  copy.x += 40;
  copy.y += 40;
  const fields = [...config.fields];
  const fieldId = layerFieldId(source);
  if (fieldId !== undefined && 'fieldId' in copy) {
    const field = config.fields.find((f) => f.id === fieldId);
    if (field) {
      const newId = uniqueId(
        `${field.id} copy`,
        fields.map((f) => f.id),
      );
      fields.push({
        ...structuredClone(field),
        id: newId,
        label: `${field.label} (copy)`.slice(0, 80),
      } as FieldSpec);
      (copy as { fieldId: string }).fieldId = newId;
    }
  }
  const index = artwork.layers.findIndex((l) => l.id === layerId);
  return {
    config: {
      ...config,
      fields,
      artworks: config.artworks.map((a) => {
        if (a.id !== artwork.id) return a;
        const layers = [...a.layers];
        layers.splice(index + 1, 0, copy);
        return { ...a, layers };
      }),
    },
    layerId: copy.id,
  };
}

/** Point a layer at an existing compatible field; the field becomes shared across artworks. */
export function bindLayerToField(
  config: ProductConfig,
  layerId: string,
  fieldId: string,
): ProductConfig {
  const field = config.fields.find((f) => f.id === fieldId);
  if (!field) return config;
  const next = updateLayer(config, layerId, { fieldId });
  const artwork = next.artworks.find((a) => a.layers.some((l) => l.id === layerId));
  const sameScope =
    (!field.artworkId || field.artworkId === artwork?.id) &&
    (!field.printableAreaId || field.printableAreaId === artwork?.printableAreaId);
  return pruneOrphanFields(
    sameScope
      ? next
      : {
          ...next,
          fields: next.fields.map((f) =>
            f.id === fieldId
              ? (merge(f as object, {
                  artworkId: undefined,
                  printableAreaId: undefined,
                }) as FieldSpec)
              : f,
          ),
        },
  );
}

// ---- fields -----------------------------------------------------------------------------------------

export function updateField(
  config: ProductConfig,
  id: string,
  patch: Record<string, unknown>,
): ProductConfig {
  return {
    ...config,
    fields: config.fields.map((f) => (f.id === id ? (merge(f as object, patch) as FieldSpec) : f)),
  };
}

/** Customer fields exist only for layers that use them: drop the rest. */
export function pruneOrphanFields(config: ProductConfig): ProductConfig {
  const bound = boundFieldIds(config);
  if (config.fields.every((f) => bound.has(f.id))) return config;
  return pruneConditions({ ...config, fields: config.fields.filter((f) => bound.has(f.id)) });
}

/** Remove `showWhen` rules that point at things that no longer exist. */
export function pruneConditions(config: ProductConfig): ProductConfig {
  const fieldIds = new Set(config.fields.map((f) => f.id));
  const artworkIds = new Set(config.artworks.map((a) => a.id));
  const areaIds = new Set(config.printableAreas.map((a) => a.id));
  const variantIds = new Set(config.variants.map((v) => v.id));
  const valid = (c: NonNullable<FieldSpec['showWhen']>): boolean => {
    switch (c.op) {
      case 'artwork':
        return (
          artworkIds.has(c.artworkId) && (!c.printableAreaId || areaIds.has(c.printableAreaId))
        );
      case 'variant':
        return c.variantIds.every((id) => variantIds.has(id));
      case 'field-equals':
      case 'field-filled':
        return fieldIds.has(c.fieldId);
      case 'all':
      case 'any':
        return c.conditions.every(valid);
      case 'not':
        return valid(c.condition);
    }
  };
  if (config.fields.every((f) => !f.showWhen || valid(f.showWhen))) return config;
  return {
    ...config,
    fields: config.fields.map((f) =>
      f.showWhen && !valid(f.showWhen)
        ? (merge(f as object, { showWhen: undefined }) as FieldSpec)
        : f,
    ),
  };
}

export function findLayer(
  config: ProductConfig,
  layerId: string,
): { artwork: Artwork; layer: ArtworkLayer } | null {
  for (const artwork of config.artworks) {
    const layer = artwork.layers.find((l) => l.id === layerId);
    if (layer) return { artwork, layer };
  }
  return null;
}

/** Copy a mockup (image, placements and overlays) into the same variants, right after the original. */
export function duplicateMockup(
  config: ProductConfig,
  id: string,
): { config: ProductConfig; id: string } | null {
  const source = config.mockups.find((m) => m.id === id);
  if (!source) return null;
  const newId = uniqueId(
    `${source.name} copy`,
    config.mockups.map((m) => m.id),
  );
  const copy: ProductMockup = {
    ...structuredClone(source),
    id: newId,
    name: `${source.name} copy`.slice(0, 80),
  };
  const index = config.mockups.findIndex((m) => m.id === id);
  const mockups = [...config.mockups];
  mockups.splice(index + 1, 0, copy);
  const next: ProductConfig = {
    ...config,
    mockups,
    variants: config.variants.map((v) =>
      v.mockupIds.includes(id) ? { ...v, mockupIds: [...v.mockupIds, newId] } : v,
    ),
  };
  return {
    config: {
      ...next,
      variants: next.variants.map((v) => ({
        ...v,
        mockupIds: orderedByMockups(next, v.mockupIds),
      })),
    },
    id: newId,
  };
}

// ---- fonts --------------------------------------------------------------------------------------

/**
 * Adds a font (the bundled defaults, or a store-uploaded custom one) to the template and makes it
 * an allowed choice on every editable text field, so it shows up in the font picker immediately.
 * A font already present (same `id`) is left untouched, not duplicated.
 */
export function addFont(
  config: ProductConfig,
  font: Omit<FontSpec, 'id'> & { id?: string },
): { config: ProductConfig; id: string } {
  if (font.id && config.fonts.some((f) => f.id === font.id)) return { config, id: font.id };
  const id = font.id ?? uniqueId(font.label ?? font.family, config.fonts.map((f) => f.id));
  const spec: FontSpec = { ...font, id };
  return {
    config: {
      ...config,
      fonts: [...config.fonts, spec],
      fields: config.fields.map((f) =>
        f.type === 'text' ? { ...f, fontIds: [...f.fontIds, id] } : f,
      ),
    },
    id,
  };
}

/**
 * Removes a font and every reference to it: dropped from each text field's allowed choices (and its
 * default, if it pointed there) and from every fixed (non-editable) text layer, falling back to the
 * font that was first in the list. A config always keeps at least one font — removing the last one
 * is refused (returns the input unchanged) rather than leaving every text field with no font at all.
 */
export function removeFont(config: ProductConfig, id: string): ProductConfig {
  const fonts = config.fonts.filter((f) => f.id !== id);
  if (fonts.length === 0 || fonts.length === config.fonts.length) return config;
  const fallback = fonts[0].id;

  const fields = config.fields.map((f): FieldSpec => {
    if (f.type !== 'text') return f;
    const fontIds = f.fontIds.filter((fid) => fid !== id).length
      ? f.fontIds.filter((fid) => fid !== id)
      : [fallback];
    const defaultValue =
      f.defaultValue?.fontId === id ? { ...f.defaultValue, fontId: fallback } : f.defaultValue;
    return { ...f, fontIds, ...(defaultValue ? { defaultValue } : {}) };
  });

  const artworks = config.artworks.map((artwork) => ({
    ...artwork,
    layers: artwork.layers.map((layer): ArtworkLayer => {
      if (layer.type !== 'text' || (layer as TextLayer).fontId !== id) return layer;
      return { ...layer, fontId: fallback } as TextLayer;
    }),
  }));

  return { ...config, fonts, fields, artworks };
}
