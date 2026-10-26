-- Migration 0002 — Product Personalization plugin schema (plugin_id = 'personalization').
--
-- Table-ownership rule: every table this plugin owns lives in the `personalization` schema. Future
-- plugins add their own schema and migrations; they never touch these tables.
--
-- Design decisions:
--  * The rendering configuration is a structured JSON document in the Angular app (ProductConfig,
--    schema v2). It is stored as JSONB verbatim — we do NOT flatten the renderer's model into
--    columns. Only lifecycle/ownership/versioning metadata is relational.
--  * Binary images are NEVER stored in these JSON columns. `personalization.assets` holds the R2
--    object key and metadata; the config JSON references stable delivery URLs / asset records.
--  * Optimistic concurrency uses `updated_at_ms` (a strictly-increasing epoch-millisecond stamp),
--    which maps directly onto the Angular repository's `expectedUpdatedAt` contract.

CREATE SCHEMA IF NOT EXISTS personalization;

-- One row per managed configuration (the merchant's unit of work: a working draft plus, once
-- published, an immutable published snapshot).
CREATE TABLE IF NOT EXISTS personalization.configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          text NOT NULL,
  plugin_id         text NOT NULL DEFAULT 'personalization',
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

-- Metadata for every binary stored in R2. The bytes live in R2 under `object_key`.
CREATE TABLE IF NOT EXISTS personalization.assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           text NOT NULL,
  plugin_id          text NOT NULL DEFAULT 'personalization',
  -- Optional association; an asset may be shared by several configs, so deleting a config does not
  -- delete the asset (reference counting is done in the service layer before any R2 delete).
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

-- Register the plugin in the shared catalogue (idempotent).
INSERT INTO platform.plugin_registry (plugin_id, display_name, version, status)
VALUES ('personalization', 'Product Personalization', '1.0.0', 'active')
ON CONFLICT (plugin_id) DO NOTHING;
