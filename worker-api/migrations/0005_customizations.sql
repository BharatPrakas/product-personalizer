-- Migration 0005 — Customer customizations, order links and cleanup bookkeeping (personalization).
--
-- Identifiers that belong to ZenBasket (store, product, variant, order, order line) are stored as
-- opaque text. There are NO foreign keys to ZenBasket's MySQL database; consistency with it is
-- enforced through the authenticated order callback (see docs/zenbasket-integration.md).
--
-- Lifecycle of a customization:   saved --(order.confirmed callback)--> ordered
--                                 saved --(inactivity expiry, cleanup job)--> expired --> purged
-- `ordered` rows are never touched by cleanup; their retention is a separate business policy.

-- Lets a customization pin (config, store, version) with ONE composite foreign key, so the database
-- itself refuses a customization whose config version belongs to another store.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_config_store_version_uq
  ON personalization.config_versions (config_id, store_id, version);

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

-- Customer-supplied binaries (uploaded artwork, rendered previews). The bytes live in PRIVATE object
-- storage under `stores/<store>/<plugin>/customizations/`, a prefix the public asset route never
-- serves. Kept apart from `personalization.assets` so merchant-asset cleanup and public delivery can
-- never touch customer files.
--   uploaded  : stored but not yet attached to a customization (abandoned after a TTL)
--   attached  : belongs to a saved / ordered customization
--   released  : no longer needed; the object is deleted after `delete_after` (grace period)
--   deleting  : claimed by a cleanup run
--   deleted   : the object is gone (row kept until its customization is purged)
CREATE TABLE IF NOT EXISTS personalization.customization_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           text NOT NULL,
  customization_id   uuid,
  kind               text NOT NULL CHECK (kind IN ('upload', 'preview')),
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

-- Durable event-id deduplication for the order callback. A row exists only for a callback that was
-- ACCEPTED (it is written in the same transaction as the link), so a rejected callback can be retried
-- with the same eventId after the cause is fixed. `payload_sha256` detects an eventId reused with a
-- different payload. Kept indefinitely (tiny rows): dedup must outlive any retry horizon.
CREATE TABLE IF NOT EXISTS personalization.integration_events (
  store_id           text NOT NULL,
  event_id           text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  event_type         text NOT NULL,
  payload_sha256     text NOT NULL,
  customization_id   uuid,
  external_order_id  text,
  external_line_id   text,
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
