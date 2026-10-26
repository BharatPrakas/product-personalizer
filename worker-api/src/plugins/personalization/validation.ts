/**
 * Server-side validation.
 *
 *  - `validateProductConfig` checks the configuration ENVELOPE and limits without ever reshaping it:
 *    it reads the object but returns it untouched, so forward-compatible fields the renderer does not
 *    yet know about are preserved (never silently dropped). Deep business validation stays in the
 *    shared Angular validator; the server guards structure, counts and payload size.
 *  - Request bodies and query params use zod. The `draft`/`snapshot` payloads are passed through as
 *    `unknown` and handed to `validateProductConfig`, so zod never strips config fields either.
 */

import { z } from 'zod';
import type { FieldIssue } from '../../shared/errors';
import type { ProductConfigLike } from './types';

/** Mirrors the Angular PRODUCT_LIMITS (product.models.ts) so client and server agree. */
export const CONFIG_LIMITS = {
  maxVariants: 40,
  maxMockups: 16,
  maxAreas: 16,
  maxArtworks: 48,
  maxFields: 80,
  maxFonts: 8,
  maxConfigBytes: 4 * 1024 * 1024,
} as const;

export interface ConfigValidation {
  ok: boolean;
  issues: FieldIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProductConfig(raw: unknown): ConfigValidation {
  const issues: FieldIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (!isPlainObject(raw)) {
    add('(root)', 'not_object', 'Configuration must be a JSON object.');
    return { ok: false, issues };
  }

  const config = raw as ProductConfigLike;

  if (typeof config.schemaVersion !== 'number' || config.schemaVersion < 1) {
    add('schemaVersion', 'invalid', 'schemaVersion must be a positive number.');
  }

  if (!isPlainObject(config.product)) {
    add('product', 'required', 'product is required.');
  } else if (typeof config.product.name !== 'string' || config.product.name.trim().length === 0) {
    add('product.name', 'required', 'product.name must be a non-empty string.');
  }

  const arrayLimits: Array<[keyof ProductConfigLike, number]> = [
    ['variants', CONFIG_LIMITS.maxVariants],
    ['mockups', CONFIG_LIMITS.maxMockups],
    ['printableAreas', CONFIG_LIMITS.maxAreas],
    ['artworks', CONFIG_LIMITS.maxArtworks],
    ['fields', CONFIG_LIMITS.maxFields],
    ['fonts', CONFIG_LIMITS.maxFonts],
  ];
  for (const [key, limit] of arrayLimits) {
    const value = config[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      add(String(key), 'invalid', `${String(key)} must be an array.`);
    } else if (value.length > limit) {
      add(String(key), 'too_many', `${String(key)} exceeds the limit of ${limit}.`);
    }
  }

  // Payload size guard (bytes of the JSON encoding).
  const size = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (size > CONFIG_LIMITS.maxConfigBytes) {
    add('(root)', 'too_large', `Configuration exceeds ${CONFIG_LIMITS.maxConfigBytes} bytes.`);
  }

  return { ok: issues.length === 0, issues };
}

// ---- request schemas -----------------------------------------------------------------------------

const clientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, 'must contain only letters, numbers, dot, underscore or hyphen');

export const createConfigSchema = z.object({
  clientConfigId: clientIdSchema.optional(),
  draft: z.unknown(),
});

export const saveDraftSchema = z.object({
  draft: z.unknown(),
  expectedUpdatedAt: z.number().int().nonnegative(),
});

export const publishSchema = z
  .object({ expectedUpdatedAt: z.number().int().nonnegative().optional() })
  .optional();

export const listQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const uploadMetadataSchema = z.object({
  filename: z.string().trim().max(255).optional(),
  clientRef: z.string().trim().max(128).optional(),
  configId: clientIdSchema.optional(),
});

export const assetListQuerySchema = z.object({
  configId: clientIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// ---- mappings & markups ---------------------------------------------------------------------------

export const MAX_BULK_ITEMS = 500;
/** Upper bound for a markup payload (bytes of its JSON encoding). */
export const MAX_MARKUP_PAYLOAD_BYTES = 256 * 1024;
/** Requests larger than this are refused before parsing (413). */
export const MAX_MARKUP_BODY_BYTES = 1024 * 1024;
const MAX_MARKUP_DEPTH = 64;

const mappingScopeSchema = z.enum(['product', 'variant', 'collection']);
const externalIdSchema = z.string().trim().min(1).max(200);
/** Empty string clears the label (stored as NULL). */
const labelSchema = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (v.length === 0 ? null : v));

const mappingItemSchema = z.object({
  scope: mappingScopeSchema,
  externalId: externalIdSchema,
  label: labelSchema.nullish(),
});

export const createMappingSchema = z.object({
  configId: clientIdSchema,
  scope: mappingScopeSchema,
  externalId: externalIdSchema,
  label: labelSchema.nullish(),
  reassign: z.boolean().optional(),
});

export const updateMappingSchema = z
  .object({
    configId: clientIdSchema.optional(),
    label: labelSchema.nullish(),
    reassign: z.boolean().optional(),
  })
  .refine((v) => v.configId !== undefined || v.label !== undefined, {
    message: 'Provide configId and/or label.',
  });

export const bulkMappingsSchema = z
  .object({
    configId: clientIdSchema,
    create: z.array(mappingItemSchema).optional(),
    deleteIds: z.array(z.uuid()).optional(),
    reassign: z.boolean().optional(),
  })
  .refine((v) => (v.create?.length ?? 0) + (v.deleteIds?.length ?? 0) <= MAX_BULK_ITEMS, {
    message: `At most ${MAX_BULK_ITEMS} items (create + deleteIds) are allowed per request.`,
    path: ['create'],
  });

const limitSchema = z.coerce.number().int().min(1).max(200).default(50);
const cursorSchema = z.string().trim().min(1).max(256).optional();

export const mappingListQuerySchema = z.object({
  configId: clientIdSchema.optional(),
  scope: mappingScopeSchema.optional(),
  externalId: externalIdSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const markupListQuerySchema = z.object({
  kind: z.enum(['area', 'artwork']).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const markupNameSchema = z.string().trim().min(1).max(120);

export const createMarkupSchema = z.object({
  name: markupNameSchema,
  kind: z.enum(['area', 'artwork']),
  payload: z.unknown(),
});

export const updateMarkupSchema = z
  .object({ name: markupNameSchema.optional(), payload: z.unknown().optional() })
  .refine((v) => v.name !== undefined || v.payload !== undefined, {
    message: 'Provide name and/or payload.',
  });

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_MARKUP_DEPTH) return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map((v) => jsonDepth(v, depth + 1)));
  if (isPlainObject(value)) {
    return Math.max(depth, ...Object.values(value).map((v) => jsonDepth(v, depth + 1)));
  }
  return depth;
}

/** A markup payload must be a JSON object, bounded in size and nesting. */
export function validateMarkupPayload(raw: unknown): ConfigValidation {
  const issues: FieldIssue[] = [];
  const add = (code: string, message: string) => issues.push({ path: 'payload', code, message });
  if (!isPlainObject(raw)) {
    add('not_object', 'payload must be a JSON object.');
    return { ok: false, issues };
  }
  if (jsonDepth(raw) > MAX_MARKUP_DEPTH) {
    add('too_deep', `payload is nested deeper than ${MAX_MARKUP_DEPTH} levels.`);
  }
  const size = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (size > MAX_MARKUP_PAYLOAD_BYTES) {
    add('too_large', `payload exceeds ${MAX_MARKUP_PAYLOAD_BYTES} bytes.`);
  }
  return { ok: issues.length === 0, issues };
}

export const storefrontSettingsSchema = z.object({
  storefrontOrigins: z.array(z.string().trim().min(1).max(300)).max(20),
});

// ---- storefront (public) ----------------------------------------------------------------------------

/** Store keys are the platform's external store ids; anything outside this alphabet cannot be one. */
export const STORE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_COLLECTION_IDS = 20;

export const storefrontConfigQuerySchema = z.object({
  storeId: z.string().trim().min(1).max(256),
  variantId: externalIdSchema.optional(),
  collectionIds: z.string().max(4000).optional(),
});
