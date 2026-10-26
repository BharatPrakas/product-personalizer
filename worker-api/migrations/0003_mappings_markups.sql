-- Migration 0003 — Product mappings and markups (personalization plugin).
--
--  * `mappings` links a host-platform product / variant / collection (an EXTERNAL id) to one
--    configuration, so the storefront can ask "which published configuration applies to this
--    product?". A (store, scope, external id) triple maps to at most ONE configuration.
--  * `markups` stores reusable, merchant-authored snippets (printable-area / artwork markup) as a
--    validated JSON object.
--
-- Per-store storefront CORS origins need no schema change: they live in the existing
-- `platform.store_plugins.settings` jsonb (key `storefrontOrigins`).
--
-- Safe to re-run: every object is guarded with IF NOT EXISTS (the runner also wraps this file in a
-- transaction and records it by checksum).

-- Lets `mappings` carry a composite foreign key (config_id, store_id) so the database itself refuses
-- a mapping whose store differs from its configuration's store (defence in depth for tenancy).
CREATE UNIQUE INDEX IF NOT EXISTS configs_id_store_uq
  ON personalization.configs (id, store_id);

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
