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
  /** Restricts the listing to images (omitted = every asset) or to store-wide custom fonts. */
  kind: z.enum(['image', 'font']).optional(),
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

// ---- customizations, uploads, order callback ----------------------------------------------------------

export const MAX_CUSTOMIZATION_DATA_BYTES = 256 * 1024;
export const MAX_CUSTOMIZATION_ASSETS = 20;
/** The callback body is a handful of short strings; anything larger is refused before parsing. */
export const MAX_CALLBACK_BODY_BYTES = 16 * 1024;
export const ORDER_EVENT_TYPE_CONFIRMED = 'order.confirmed';

const uuidSchema = z.string().trim().pipe(z.uuid());

/** Every public customer route is addressed to a store by its public key, in the query string. */
export const customerStoreQuerySchema = z.object({
  storeId: z.string().trim().min(1).max(256),
});

export const customerUploadQuerySchema = customerStoreQuerySchema.extend({
  kind: z.enum(['upload', 'preview', 'artwork']).default('upload'),
  filename: z.string().trim().max(255).optional(),
});

const assetRefSchema = z.object({
  assetId: uuidSchema,
  /** Required to attach a new upload; omitted for assets already attached to this customization. */
  uploadToken: z.string().min(1).max(2048).optional(),
});

const customizationDataSchema = z.unknown().superRefine((value, ctx) => {
  const result = validateCustomizationData(value);
  for (const issue of result.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [] });
});

export const createCustomizationSchema = z.object({
  productId: externalIdSchema,
  variantId: externalIdSchema.optional(),
  collectionIds: z.array(externalIdSchema).max(MAX_COLLECTION_IDS).optional(),
  /** The configuration the storefront rendered (`configId` / `version` of the config response). */
  configId: clientIdSchema,
  configVersion: z.number().int().min(1),
  data: customizationDataSchema,
  assets: z.array(assetRefSchema).max(MAX_CUSTOMIZATION_ASSETS).default([]),
});

export const updateCustomizationSchema = z.object({
  data: customizationDataSchema,
  assets: z.array(assetRefSchema).max(MAX_CUSTOMIZATION_ASSETS).default([]),
});

/** A customization payload must be a JSON object, bounded in size and nesting. */
export function validateCustomizationData(raw: unknown): ConfigValidation {
  const issues: FieldIssue[] = [];
  const add = (code: string, message: string) => issues.push({ path: 'data', code, message });
  if (!isPlainObject(raw)) {
    add('not_object', 'data must be a JSON object.');
    return { ok: false, issues };
  }
  if (jsonDepth(raw) > MAX_MARKUP_DEPTH) add('too_deep', `data is nested deeper than ${MAX_MARKUP_DEPTH} levels.`);
  const size = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (size > MAX_CUSTOMIZATION_DATA_BYTES) add('too_large', `data exceeds ${MAX_CUSTOMIZATION_DATA_BYTES} bytes.`);
  return { ok: issues.length === 0, issues };
}

/**
 * The signed order-event envelope (Extension Platform Contract v1, section 7). Strict: unknown keys are
 * rejected so a typo in the integration (e.g. `order_id`) fails loudly instead of being silently ignored.
 * `lines` holds only the order lines that carry this extension's line extensions.
 */
const orderLineSchema = z
  .object({
    id: externalIdSchema,
    productId: externalIdSchema,
    /** Optional: the purchased variant. When present and the customization recorded one, they must match. */
    variantId: externalIdSchema.optional(),
    quantity: z.number().int().min(1).max(1_000_000).optional(),
    /** The extension's own namespace, keys without the prefix, e.g. `{ customizationId }`. */
    extensions: z.record(z.string().min(1).max(40), z.string().max(512)).default({}),
  })
  .strict();

export const MAX_ORDER_EVENT_LINES = 100;

export const orderEventSchema = z
  .object({
    contract: z.literal(1),
    eventId: z.string().trim().min(1).max(128),
    type: z.string().trim().min(1).max(64),
    occurredAt: z.iso.datetime({ offset: true }),
    storeId: z.string().trim().min(1).max(256),
    order: z.object({ id: externalIdSchema }).strict(),
    lines: z.array(orderLineSchema).min(1).max(MAX_ORDER_EVENT_LINES),
  })
  .strict()
  .refine((event) => new Set(event.lines.map((l) => l.id)).size === event.lines.length, {
    message: 'Line ids must be unique within an event.',
    path: ['lines'],
  });

export const credentialCreateSchema = z.object({
  label: z.string().trim().max(120).default(''),
});

export const credentialRotateSchema = z
  .object({ gracePeriodSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60).optional() })
  .default({});

export const customizationListQuerySchema = z.object({
  status: z.enum(['saved', 'ordered', 'expired']).optional(),
  orderId: externalIdSchema.optional(),
  productId: externalIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).max(256).optional(),
});
