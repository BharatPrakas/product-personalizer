import type { FieldSpec } from '../customizer/models/config.models';
import type { ArtworkLayer, BoundarySpec, ShapeSpec } from '../customizer/models/product.models';
import type { CanvasSpec, PrintSpec } from '../customizer/models/config.models';

export type MarkupKind = 'area' | 'artwork';

/** A printable area's geometry: canvas, mask, print size and boundary (no artwork). */
export interface AreaMarkupPayload {
  v: 1;
  kind: 'area';
  area: {
    name: string;
    canvas: CanvasSpec;
    shape: ShapeSpec;
    print?: PrintSpec;
    boundary?: BoundarySpec;
  };
}

/** An artwork's layer set plus the customer fields its layers are bound to. */
export interface ArtworkMarkupPayload {
  v: 1;
  kind: 'artwork';
  artwork: { name: string; background?: string; layers: ArtworkLayer[] };
  /** Fields referenced by `layer.fieldId`, without their area / artwork scope. */
  fields: FieldSpec[];
}

export type MarkupPayload = AreaMarkupPayload | ArtworkMarkupPayload;

export interface Markup<P extends MarkupPayload = MarkupPayload> {
  id: string;
  name: string;
  kind: P['kind'];
  payload: P;
  createdAt: number;
  updatedAt: number;
}

export class MarkupNameTakenError extends Error {
  constructor() {
    super('A markup with that name already exists.');
    this.name = 'MarkupNameTakenError';
  }
}

export class MarkupInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkupInvalidError';
  }
}

export const MAX_MARKUP_NAME = 120;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Structural check of a stored payload before it is inserted into a template. Stored markups
 * could be hand-edited or come from an older build, so nothing is assumed; the template's own
 * validation still runs on the result.
 */
export function parsePayload(raw: unknown, kind: MarkupKind): MarkupPayload {
  if (!isObject(raw) || raw['v'] !== 1 || raw['kind'] !== kind) {
    throw new MarkupInvalidError('This markup is not in a supported format.');
  }
  if (kind === 'area') {
    const area = raw['area'];
    if (
      !isObject(area) ||
      typeof area['name'] !== 'string' ||
      !isObject(area['canvas']) ||
      !finite(area['canvas']['width']) ||
      !finite(area['canvas']['height']) ||
      !isObject(area['shape']) ||
      typeof area['shape']['type'] !== 'string'
    ) {
      throw new MarkupInvalidError('This area markup is incomplete.');
    }
    return raw as unknown as AreaMarkupPayload;
  }
  const artwork = raw['artwork'];
  if (
    !isObject(artwork) ||
    typeof artwork['name'] !== 'string' ||
    !Array.isArray(artwork['layers']) ||
    !artwork['layers'].every(
      (l) => isObject(l) && typeof l['id'] === 'string' && typeof l['type'] === 'string',
    ) ||
    !Array.isArray(raw['fields']) ||
    !raw['fields'].every(
      (f) => isObject(f) && typeof f['id'] === 'string' && typeof f['type'] === 'string',
    )
  ) {
    throw new MarkupInvalidError('This artwork markup is incomplete.');
  }
  return raw as unknown as ArtworkMarkupPayload;
}

export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_MARKUP_NAME) {
    throw new MarkupInvalidError(`Give the markup a name of 1-${MAX_MARKUP_NAME} characters.`);
  }
  return trimmed;
}
