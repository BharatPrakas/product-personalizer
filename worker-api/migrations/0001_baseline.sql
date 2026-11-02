-- Migration 0001 — Baseline schema of the Product Personalization service.
--
-- This Worker and its database exist only for Product Personalization, so everything lives in ONE
-- schema, `personalization`, including the migration ledger (`schema_migrations`, created by the
-- runner). The service owns no users or stores: ZenBasket's identity system (a separate MySQL
-- database, never touched here) is the source of truth, and stores are referenced by their stable
-- EXTERNAL id as a text column — no foreign key into a local stores table.
--
-- Design decisions:
--  * The rendering configuration is a structured JSON document in the Angular app (ProductConfig,
--    schema v2). It is stored as JSONB verbatim — we do NOT flatten the renderer's model into
--    columns. Only lifecycle/ownership/versioning metadata is relational.
--  * Binary images are NEVER stored in these JSON columns. `assets` holds the object key and
--    metadata; the config JSON references stable delivery URLs / asset records.
--  * Optimistic concurrency uses `updated_at_ms` (a strictly-increasing epoch-millisecond stamp),
--    which maps directly onto the Angular repository's `expectedUpdatedAt` contract.
--  * Identifiers that belong to ZenBasket (store, product, variant, order, order line) are opaque
--    text. There are NO foreign keys to ZenBasket's MySQL database; consistency with it is enforced
--    through the authenticated order callback (see docs/zenbasket-integration.md).
--
-- Safe to re-run: every object is guarded with IF NOT EXISTS. `gen_random_uuid()` is built in on
-- PostgreSQL 13+ (no extension required).

CREATE SCHEMA IF NOT EXISTS personalization;

-- ---- stores ---------------------------------------------------------------------------------------

-- One row per store (tenant) that has used this service; `store_id` is the external id. The row is
-- created on the store's first authenticated request (the hosting platform only issues tokens for
-- stores that have the extension), and the public routes treat a store without a row as unknown.
CREATE TABLE IF NOT EXISTS personalization.store_settings (
  store_id            text PRIMARY KEY,
  -- Browser origins allowed to call the PUBLIC storefront routes cross-origin. Empty = none.
  storefront_origins  text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail of privileged operations. Never stores secrets, tokens or payload bodies —
-- only identifiers, the action, and small structured metadata (counts, ids).
CREATE TABLE IF NOT EXISTS personalization.audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    text,
  store_id      text,
  actor         text,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_store_idx ON personalization.audit_logs (store_id, created_at DESC);

-- Per-store integration credentials. Server-to-server callers (for example ZenBasket's order service)
-- authenticate with a per-store HMAC secret. The secret must be recoverable by the Worker to verify
-- signatures, so it is stored ENCRYPTED (AES-256-GCM, see src/modules/integration-credentials/crypto.ts),
-- never hashed. The master key lives only in a Worker secret (`INTEGRATION_ENCRYPTION_KEY`); the
-- plaintext secret is shown once, at creation, to the caller.
--
-- Several credentials may be live per store at once: that is how rotation works — issue a new one,
-- then let the old one lapse (`expires_at`) or revoke it.
CREATE TABLE IF NOT EXISTS personalization.integration_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          text NOT NULL,
  label             text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
  -- `v1.<iv>.<tag>.<ciphertext>` (base64url), bound to (store_id, id) as AEAD associated data.
  secret_encrypted  text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Set on the OLD credential when it is rotated: it stays valid until then. NULL = no expiry.
  expires_at        timestamptz,
  revoked_at        timestamptz,
  last_used_at      timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_credentials_store_idx
  ON personalization.integration_credentials (store_id, status);

-- ---- configurations ------------------------------------------------------------------------------

-- One row per managed configuration (the merchant's unit of work: a working draft plus, once
-- published, an immutable published snapshot).
CREATE TABLE IF NOT EXISTS personalization.configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          text NOT NULL,
  -- The Angular app's own id (e.g. 'cfg-ab12cd34'). Lets IndexedDB migration be idempotent and lets
  -- the client keep a stable local<->cloud mapping. Unique per store when present.
  client_config_id  text,
  -- Denormalised from draft.product.name for cheap listing / search / sort.
  name              text NOT NULL DEFAULT 'Untitled configuration',
  schema_version    integer NOT NULL,
  -- The working draft (status: 'draft'). Always present.
  draft             jsonb NOT NULL,
  -- The last published snapshot (status: 'published'), or NULL before the first publish.
  published         jsonb,
  -- Strictly-increasing stamps (epoch ms). `updated_at_ms` is the optimistic-concurrency token.
  created_at_ms     bigint NOT NULL,
  updated_at_ms     bigint NOT NULL,
  published_at_ms   bigint,
  archived_at_ms    bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configs_schema_version_chk CHECK (schema_version >= 1)
);

-- A store cannot reach another store's config by guessing an id: every query is scoped by store_id,
-- and this partial unique index keeps the client id stable within a store.
CREATE UNIQUE INDEX IF NOT EXISTS configs_store_client_uq
  ON personalization.configs (store_id, client_config_id)
  WHERE client_config_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS configs_store_updated_idx
  ON personalization.configs (store_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS configs_store_archived_idx
  ON personalization.configs (store_id, archived_at_ms);

-- Lets `mappings` carry a composite foreign key (config_id, store_id) so the database itself refuses
-- a mapping whose store differs from its configuration's store (defence in depth for tenancy).
CREATE UNIQUE INDEX IF NOT EXISTS configs_id_store_uq
  ON personalization.configs (id, store_id);

-- Immutable publish history. One row per publish; never updated in place.
CREATE TABLE IF NOT EXISTS personalization.config_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id      uuid NOT NULL REFERENCES personalization.configs (id) ON DELETE CASCADE,
  store_id       text NOT NULL,
  version        integer NOT NULL,
  snapshot       jsonb NOT NULL,
  created_at_ms  bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_versions_version_uq UNIQUE (config_id, version)
);

CREATE INDEX IF NOT EXISTS config_versions_config_idx
  ON personalization.config_versions (config_id, created_at_ms DESC);

-- Lets a customization pin (config, store, version) with ONE composite foreign key, so the database
-- itself refuses a customization whose config version belongs to another store.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_config_store_version_uq
  ON personalization.config_versions (config_id, store_id, version);

-- Metadata for every merchant binary in object storage. The bytes live under `object_key`.
CREATE TABLE IF NOT EXISTS personalization.assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           text NOT NULL,
  -- Optional association; an asset may be shared by several configs, so deleting a config does not
  -- delete the asset (reference counting is done in the service layer before any object delete).
  config_id          uuid REFERENCES personalization.configs (id) ON DELETE SET NULL,
  object_key         text NOT NULL UNIQUE,
  original_filename  text,
  content_type       text NOT NULL,
  size_bytes         bigint NOT NULL,
  width              integer,
  height             integer,
  checksum_sha256    text,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'stored', 'deleted')),
  -- The client's local reference (e.g. 'idb:a1b2...') for idempotent migration + dedupe.
  client_ref         text,
  created_at_ms      bigint NOT NULL,
  updated_at_ms      bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS assets_store_client_ref_uq
  ON personalization.assets (store_id, client_ref)
  WHERE client_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS assets_store_idx  ON personalization.assets (store_id, status);
CREATE INDEX IF NOT EXISTS assets_config_idx ON personalization.assets (config_id);

-- ---- mappings and markups ------------------------------------------------------------------------

--  * `mappings` links a host-platform product / variant / collection (an EXTERNAL id) to one
--    configuration, so the storefront can ask "which published configuration applies to this
--    product?". A (store, scope, external id) triple maps to at most ONE configuration.
--  * `markups` stores reusable, merchant-authored snippets (printable-area / artwork markup) as a
--    validated JSON object.
CREATE TABLE IF NOT EXISTS personalization.mappings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       text NOT NULL,
  config_id      uuid NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('product', 'variant', 'collection')),
  -- The host platform's id for the product / variant / collection (opaque to this service).
  external_id    text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  -- Cached host product title for display in the admin UI; never used for resolution.
  label          text CHECK (label IS NULL OR char_length(label) <= 200),
  created_at_ms  bigint NOT NULL,
  updated_at_ms  bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Deleting a configuration removes its mappings.
  CONSTRAINT mappings_config_fk FOREIGN KEY (config_id, store_id)
    REFERENCES personalization.configs (id, store_id) ON DELETE CASCADE,
  CONSTRAINT mappings_target_uq UNIQUE (store_id, scope, external_id)
);

CREATE INDEX IF NOT EXISTS mappings_store_config_idx
  ON personalization.mappings (store_id, config_id);
CREATE INDEX IF NOT EXISTS mappings_store_created_idx
  ON personalization.mappings (store_id, created_at_ms DESC, id DESC);

CREATE TABLE IF NOT EXISTS personalization.markups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       text NOT NULL,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind           text NOT NULL CHECK (kind IN ('area', 'artwork')),
  -- Validated by the API: a JSON object of at most ~256 KB.
  payload        jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at_ms  bigint NOT NULL,
  updated_at_ms  bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Names are unique per store and kind, ignoring case.
CREATE UNIQUE INDEX IF NOT EXISTS markups_store_kind_name_uq
  ON personalization.markups (store_id, kind, lower(name));
CREATE INDEX IF NOT EXISTS markups_store_kind_idx
  ON personalization.markups (store_id, kind);
CREATE INDEX IF NOT EXISTS markups_store_created_idx
  ON personalization.markups (store_id, created_at_ms DESC, id DESC);

-- ---- customizations, order links and cleanup bookkeeping -----------------------------------------

-- Lifecycle of a customization:   saved --(order.confirmed event)--> ordered
--                                 saved --(inactivity expiry, cleanup job)--> expired --> purged
-- `ordered` rows are never touched by cleanup; their retention is a separate business policy.
CREATE TABLE IF NOT EXISTS personalization.customizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id             text NOT NULL,
  config_id            uuid NOT NULL,
  -- The published version the customer designed against (immutable snapshot in config_versions).
  config_version       integer NOT NULL,
  -- The ZenBasket product page the customization was made on, as resolved by the mapping at save time.
  product_external_id  text NOT NULL CHECK (char_length(product_external_id) BETWEEN 1 AND 200),
  variant_external_id  text CHECK (variant_external_id IS NULL OR char_length(variant_external_id) BETWEEN 1 AND 200),
  mapping_scope        text NOT NULL CHECK (mapping_scope IN ('product', 'variant', 'collection')),
  mapping_external_id  text NOT NULL CHECK (char_length(mapping_external_id) BETWEEN 1 AND 200),
  status               text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'ordered', 'expired')),
  -- The customer's input (text, positions, asset references). Cleared when a customization expires.
  data                 jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  last_activity_at     timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz,
  ordered_at           timestamptz,
  expired_at           timestamptz,
  created_at_ms        bigint NOT NULL,
  updated_at_ms        bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- A customization can never be deleted out from under a config delete: deleting a configuration
  -- that customers have designed against (or ordered) is refused.
  CONSTRAINT customizations_version_fk FOREIGN KEY (config_id, store_id, config_version)
    REFERENCES personalization.config_versions (config_id, store_id, version) ON DELETE RESTRICT,
  CONSTRAINT customizations_id_store_uq UNIQUE (id, store_id),
  -- Status and its timestamps must agree (an `ordered` row has no expiry; only `saved` rows expire).
  CONSTRAINT customizations_state_chk CHECK (
       (status = 'saved'   AND expires_at IS NOT NULL AND ordered_at IS NULL AND expired_at IS NULL)
    OR (status = 'ordered' AND ordered_at IS NOT NULL AND expires_at IS NULL AND expired_at IS NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND expires_at IS NULL AND ordered_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS customizations_store_created_idx
  ON personalization.customizations (store_id, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS customizations_store_status_idx
  ON personalization.customizations (store_id, status, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS customizations_expiry_idx
  ON personalization.customizations (expires_at) WHERE status = 'saved';
CREATE INDEX IF NOT EXISTS customizations_purge_idx
  ON personalization.customizations (expired_at) WHERE status = 'expired';
CREATE INDEX IF NOT EXISTS customizations_config_idx
  ON personalization.customizations (config_id, store_id, config_version);
CREATE INDEX IF NOT EXISTS customizations_product_idx
  ON personalization.customizations (store_id, product_external_id);

-- Customer-supplied binaries. The bytes live in PRIVATE object storage under
-- `stores/<store>/product-personalization/customizations/`, a prefix the public asset route never
-- serves. Kept apart from `assets` so merchant-asset cleanup and public delivery can never touch
-- customer files.
--   kind     upload   : the shopper's own photo
--            preview  : a rendered composite
--            artwork  : the per-printable-area, print-ready file the design is exported to
--   status   uploaded : stored but not yet attached to a customization (abandoned after a TTL)
--            attached : belongs to a saved / ordered customization
--            released : no longer needed; the object is deleted after `delete_after` (grace period)
--            deleting : claimed by a cleanup run
--            deleted  : the object is gone (row kept until its customization is purged)
CREATE TABLE IF NOT EXISTS personalization.customization_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           text NOT NULL,
  customization_id   uuid,
  kind               text NOT NULL CHECK (kind IN ('upload', 'preview', 'artwork')),
  object_key         text NOT NULL UNIQUE,
  original_filename  text,
  content_type       text NOT NULL,
  size_bytes         bigint NOT NULL,
  width              integer,
  height             integer,
  checksum_sha256    text,
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded', 'attached', 'released', 'deleting', 'deleted')),
  delete_after       timestamptz,
  delete_attempts    integer NOT NULL DEFAULT 0,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  attached_at        timestamptz,
  deleted_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customization_assets_owner_fk FOREIGN KEY (customization_id, store_id)
    REFERENCES personalization.customizations (id, store_id) ON DELETE CASCADE,
  CONSTRAINT customization_assets_owner_chk CHECK (
       (status = 'uploaded' AND customization_id IS NULL)
    OR (status = 'attached' AND customization_id IS NOT NULL)
    OR status IN ('released', 'deleting', 'deleted')
  )
);

CREATE INDEX IF NOT EXISTS customization_assets_owner_idx
  ON personalization.customization_assets (customization_id);
CREATE INDEX IF NOT EXISTS customization_assets_release_idx
  ON personalization.customization_assets (delete_after) WHERE status = 'released';
CREATE INDEX IF NOT EXISTS customization_assets_unattached_idx
  ON personalization.customization_assets (created_at) WHERE status = 'uploaded';
CREATE INDEX IF NOT EXISTS customization_assets_deleting_idx
  ON personalization.customization_assets (updated_at) WHERE status = 'deleting';

-- The ZenBasket order line a customization was bought on.
--   UNIQUE (customization_id)                         one customization is ordered at most once
--   UNIQUE (store_id, external_order_id, external_line_id)   one order line carries one customization
CREATE TABLE IF NOT EXISTS personalization.order_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id             text NOT NULL,
  customization_id     uuid NOT NULL,
  external_order_id    text NOT NULL CHECK (char_length(external_order_id) BETWEEN 1 AND 200),
  external_line_id     text NOT NULL CHECK (char_length(external_line_id) BETWEEN 1 AND 200),
  product_external_id  text NOT NULL,
  event_id             text NOT NULL,
  occurred_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_links_customization_fk FOREIGN KEY (customization_id, store_id)
    REFERENCES personalization.customizations (id, store_id) ON DELETE RESTRICT,
  CONSTRAINT order_links_customization_uq UNIQUE (customization_id),
  CONSTRAINT order_links_line_uq UNIQUE (store_id, external_order_id, external_line_id)
);

CREATE INDEX IF NOT EXISTS order_links_order_idx
  ON personalization.order_links (store_id, external_order_id);

-- Durable event-id deduplication for order events. One row per processed event (it may carry several
-- order lines), written in the same transaction as its links, so a failed event leaves nothing behind
-- and can be retried with the same eventId. `results` holds the per-line outcome, so a replay answers
-- identically; `payload_sha256` detects an eventId reused with a different payload. Kept indefinitely
-- (tiny rows): dedup must outlive any retry horizon.
CREATE TABLE IF NOT EXISTS personalization.integration_events (
  store_id           text NOT NULL,
  event_id           text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  event_type         text NOT NULL,
  payload_sha256     text NOT NULL,
  external_order_id  text,
  line_count         integer,
  results            jsonb,
  credential_id      uuid,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  request_id         text,
  PRIMARY KEY (store_id, event_id)
);

-- One row per scheduled cleanup run: what it did and whether it finished.
CREATE TABLE IF NOT EXISTS personalization.cleanup_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger                  text NOT NULL,
  status                   text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  customizations_expired   integer NOT NULL DEFAULT 0,
  uploads_released         integer NOT NULL DEFAULT 0,
  assets_deleted           integer NOT NULL DEFAULT 0,
  assets_failed            integer NOT NULL DEFAULT 0,
  tombstones_purged        integer NOT NULL DEFAULT 0,
  error                    text
);

CREATE INDEX IF NOT EXISTS cleanup_runs_started_idx
  ON personalization.cleanup_runs (started_at DESC);
