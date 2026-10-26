/**
 * Pure transformations between a template and a markup: capture an area or an artwork, and insert
 * one into another template by copy (never a live link). Insertion generates fresh ids for
 * everything, so repeated or cross-template inserts cannot collide.
 */

import { FieldSpec, ImageFieldSpec, TextFieldSpec } from '../customizer/models/config.models';
import {
  Artwork,
  ArtworkLayer,
  PrintableArea,
  ProductConfig,
  layerFieldId,
} from '../customizer/models/product.models';
import * as edit from '../editor/util/config-edit';
import type { AreaMarkupPayload, ArtworkMarkupPayload } from './markup.models';

export function areaToMarkup(config: ProductConfig, areaId: string): AreaMarkupPayload | null {
  const area = config.printableAreas.find((a) => a.id === areaId);
  if (!area) return null;
  return {
    v: 1,
    kind: 'area',
    area: structuredClone({
      name: area.name,
      canvas: area.canvas,
      shape: area.shape,
      ...(area.print ? { print: area.print } : {}),
      ...(area.boundary ? { boundary: area.boundary } : {}),
    }),
  };
}

export function artworkToMarkup(
  config: ProductConfig,
  artworkId: string,
): ArtworkMarkupPayload | null {
  const artwork = config.artworks.find((a) => a.id === artworkId);
  if (!artwork) return null;
  const ids = new Set(
    artwork.layers.map(layerFieldId).filter((id): id is string => id !== undefined),
  );
  const fields = config.fields
    .filter((f) => ids.has(f.id))
    .map((f) => {
      const copy = structuredClone(f) as unknown as Record<string, unknown>;
      // Scope and visibility rules refer to this template's areas and fields.
      delete copy['printableAreaId'];
      delete copy['artworkId'];
      delete copy['showWhen'];
      return copy as unknown as FieldSpec;
    });
  return {
    v: 1,
    kind: 'artwork',
    artwork: structuredClone({
      name: artwork.name,
      ...(artwork.background ? { background: artwork.background } : {}),
      layers: artwork.layers,
    }),
    fields,
  };
}

export interface InsertAreaResult {
  config: ProductConfig;
  areaId: string;
  artworkId: string;
}

/**
 * A new area (with an empty artwork) shaped like the markup. It is enabled for every variant but
 * not placed on a mockup yet: placement belongs to the template the markup is inserted into.
 */
export function insertAreaMarkup(
  config: ProductConfig,
  payload: AreaMarkupPayload,
  options: { name?: string } = {},
): InsertAreaResult {
  const { area } = payload;
  const added = edit.addArea(config, {
    name: (options.name ?? area.name).slice(0, 60),
    shape: structuredClone(area.shape),
    canvasWidth: area.canvas.width,
    canvasHeight: area.canvas.height,
  });
  const patch: Partial<Omit<PrintableArea, 'id'>> = {
    canvas: structuredClone(area.canvas),
    ...(area.print ? { print: structuredClone(area.print) } : {}),
    ...(area.boundary ? { boundary: structuredClone(area.boundary) } : {}),
  };
  return {
    config: edit.updateArea(added.config, added.areaId, patch),
    areaId: added.areaId,
    artworkId: added.artworkId,
  };
}

export interface InsertArtworkResult {
  config: ProductConfig;
  artworkId: string;
  warnings: string[];
}

/** A copy of the markup's artwork inside `areaId`, with its own layer ids and customer fields. */
export function insertArtworkMarkup(
  config: ProductConfig,
  areaId: string,
  payload: ArtworkMarkupPayload,
  options: { name?: string } = {},
): InsertArtworkResult | null {
  if (!config.printableAreas.some((a) => a.id === areaId)) return null;
  const warnings: string[] = [];
  const added = edit.addArtwork(
    config,
    areaId,
    (options.name ?? payload.artwork.name).slice(0, 60),
  );
  const artworkId = added.id;

  const fontIds = new Set(config.fonts.map((f) => f.id));
  const firstFont = config.fonts[0]?.id;
  let fontFallback = false;
  const fieldIds = new Set(config.fields.map((f) => f.id));
  const layerIds = new Set(config.artworks.flatMap((a) => a.layers.map((l) => l.id)));
  const fieldMap = new Map<string, string>();
  const newFields: FieldSpec[] = [];

  const sourceFields = new Map(payload.fields.map((f) => [f.id, f]));
  const layers = payload.artwork.layers.map((layer): ArtworkLayer => {
    const copy = structuredClone(layer);
    copy.id = edit.uniqueId(layer.id, layerIds);
    layerIds.add(copy.id);
    if (copy.type === 'text' && copy.fontId && !fontIds.has(copy.fontId)) {
      if (firstFont) copy.fontId = firstFont;
      else delete copy.fontId;
      fontFallback = true;
    }
    const fieldId = layerFieldId(layer);
    if (fieldId !== undefined && 'fieldId' in copy) {
      let mapped = fieldMap.get(fieldId);
      if (!mapped) {
        const field = sourceFields.get(fieldId);
        if (field) {
          mapped = edit.uniqueId(field.id, fieldIds);
          fieldIds.add(mapped);
          fieldMap.set(fieldId, mapped);
          const next = structuredClone(field) as FieldSpec & { fontIds?: string[] };
          next.id = mapped;
          next.printableAreaId = areaId;
          next.artworkId = artworkId;
          if (next.type === 'text') {
            const text = next as unknown as TextFieldSpec;
            const kept = text.fontIds.filter((f) => fontIds.has(f));
            if (kept.length !== text.fontIds.length) fontFallback = true;
            text.fontIds = kept.length > 0 ? kept : firstFont ? [firstFont] : [];
            if (
              text.defaultValue?.fontId !== undefined &&
              !fontIds.has(text.defaultValue.fontId) &&
              firstFont
            ) {
              text.defaultValue = { ...text.defaultValue, fontId: firstFont };
            }
          }
          newFields.push(next as FieldSpec);
        }
      }
      if (mapped) (copy as { fieldId: string }).fieldId = mapped;
    }
    return copy;
  });
  if (fontFallback) warnings.push('fonts');

  const artwork: Artwork = {
    ...added.config.artworks.find((a) => a.id === artworkId)!,
    ...(payload.artwork.background ? { background: payload.artwork.background } : {}),
    layers,
  };
  return {
    config: {
      ...added.config,
      artworks: added.config.artworks.map((a) => (a.id === artworkId ? artwork : a)),
      fields: [...added.config.fields, ...newFields],
    },
    artworkId,
    warnings,
  };
}

export type { ImageFieldSpec };
