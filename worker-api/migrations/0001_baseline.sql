-- Migration 0001 — Baseline schema of the Product Personalization service, D1 (SQLite) dialect.
--
-- Ported from migrations/0001_baseline.sql (PostgreSQL). D1 is a single flat SQLite database, so the
-- `personalization.` schema prefix is dropped (no other schema exists to collide with). Differences
-- from the Postgres original, all deliberate:
--  * uuid -> TEXT. SQLite has no gen_random_uuid(); every id is generated app-side with
--    `crypto.randomUUID()` and always supplied on INSERT (no column DEFAULT).
--  * timestamptz -> TEXT, ISO-8601 UTC with milliseconds (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
--    matching `Date.prototype.toISOString()` so the app can compare/bind either representation
--    interchangeably. Every timestamp column in this schema uses this exact format — never mixed.
--  * jsonb -> TEXT, validated with `json_valid()` / `json_type()` (SQLite's JSON1 functions) in place
--    of `jsonb_typeof()`. The app stores `JSON.stringify(...)`; D1 does not parse it back.
--  * text[] (store_settings.storefront_origins) -> TEXT holding a JSON array string.
--  * bigint epoch-ms columns -> INTEGER (SQLite integers are 64-bit; no change in practice).
--  * `FOR UPDATE ... SKIP LOCKED` has no equivalent and needs none: D1 serializes every write to a
--    single logical writer, so two cleanup runs cannot interleave their claims the way two concurrent
--    Postgres transactions could. The claim-then-verify shape (conditional UPDATE, check rowcount) is
--    kept; only the locking clause is dropped. See cleanup-service.ts.
--  * `customizations.pending_attach_count` and its two triggers near the bottom of this file replace
--    the Postgres pattern of inserting a customization and conditionally claiming N uploads inside one
--    transaction, rolling back the whole thing if any upload couldn't be claimed. D1's `batch()` has no
--    mid-batch branching, so the same all-or-nothing guarantee is enforced in SQL via a counter trigger
--    plus a `RAISE(ABORT, ...)` guard — not a compensating write after the fact. See
--    customization-service.ts and customization-repository.ts.
--  * `integration_events.status` is new: it lets a crashed or concurrently-retried order event be
--    safely re-processed (every line's own write is already conditional/idempotent) instead of
--    answering with incomplete stored results. See order-callback-service.ts.
--
-- D1 enables foreign-key enforcement by default; this migration relies on that (composite FKs below
-- require the referenced composite UNIQUE indexes, created alongside each table, same as Postgres).
--
-- Applied via `wrangler d1 migrations apply` (see migrations_dir in wrangler.jsonc), not the
-- Postgres-specific scripts/migrate.mjs runner.

-- ---- stores ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS store_settings (
  store_id            TEXT PRIMARY KEY,
  storefront_origins  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(storefront_origins) AND json_type(storefront_origins) = 'array'),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  request_id    TEXT,
  store_id      TEXT,
  actor         TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS audit_logs_store_idx ON audit_logs (store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_credentials (
  id                TEXT PRIMARY KEY,
  store_id          TEXT NOT NULL,
  label             TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 120),
  secret_encrypted  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at        TEXT,
  revoked_at        TEXT,
  last_used_at      TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS integration_credentials_store_idx
  ON integration_credentials (store_id, status);

-- ---- configurations ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS configs (
  id                TEXT PRIMARY KEY,
  store_id          TEXT NOT NULL,
  client_config_id  TEXT,
  name              TEXT NOT NULL DEFAULT 'Untitled configuration',
  schema_version    INTEGER NOT NULL CHECK (schema_version >= 1),
  draft             TEXT NOT NULL CHECK (json_valid(draft) AND json_type(draft) = 'object'),
  published         TEXT CHECK (published IS NULL OR (json_valid(published) AND json_type(published) = 'object')),
  created_at_ms     INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL,
  published_at_ms   INTEGER,
  archived_at_ms    INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS configs_store_client_uq
  ON configs (store_id, client_config_id)
  WHERE client_config_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS configs_store_updated_idx
  ON configs (store_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS configs_store_archived_idx
  ON configs (store_id, archived_at_ms);

-- Backs the composite FK from `mappings`, exactly as in the Postgres schema.
CREATE UNIQUE INDEX IF NOT EXISTS configs_id_store_uq
  ON configs (id, store_id);

CREATE TABLE IF NOT EXISTS config_versions (
  id             TEXT PRIMARY KEY,
  config_id      TEXT NOT NULL REFERENCES configs (id) ON DELETE CASCADE,
  store_id       TEXT NOT NULL,
  version        INTEGER NOT NULL,
  snapshot       TEXT NOT NULL CHECK (json_valid(snapshot) AND json_type(snapshot) = 'object'),
  created_at_ms  INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT config_versions_version_uq UNIQUE (config_id, version)
);

CREATE INDEX IF NOT EXISTS config_versions_config_idx
  ON config_versions (config_id, created_at_ms DESC);

-- Backs the composite FK from `customizations`.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_config_store_version_uq
  ON config_versions (config_id, store_id, version);

CREATE TABLE IF NOT EXISTS assets (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT NOT NULL,
  config_id          TEXT REFERENCES configs (id) ON DELETE SET NULL,
  object_key         TEXT NOT NULL UNIQUE,
  original_filename  TEXT,
  content_type       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  width              INTEGER,
  height             INTEGER,
  checksum_sha256    TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'stored', 'deleted')),
  client_ref         TEXT,
  created_at_ms      INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS assets_store_client_ref_uq
  ON assets (store_id, client_ref)
  WHERE client_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS assets_store_idx  ON assets (store_id, status);
CREATE INDEX IF NOT EXISTS assets_config_idx ON assets (config_id);

-- ---- mappings and markups ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mappings (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL,
  config_id      TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('product', 'variant', 'collection')),
  external_id    TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  label          TEXT CHECK (label IS NULL OR length(label) <= 200),
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT mappings_config_fk FOREIGN KEY (config_id, store_id)
    REFERENCES configs (id, store_id) ON DELETE CASCADE,
  CONSTRAINT mappings_target_uq UNIQUE (store_id, scope, external_id)
);

CREATE INDEX IF NOT EXISTS mappings_store_config_idx
  ON mappings (store_id, config_id);
CREATE INDEX IF NOT EXISTS mappings_store_created_idx
  ON mappings (store_id, created_at_ms DESC, id DESC);

CREATE TABLE IF NOT EXISTS markups (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind           TEXT NOT NULL CHECK (kind IN ('area', 'artwork')),
  payload        TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS markups_store_kind_name_uq
  ON markups (store_id, kind, lower(name));
CREATE INDEX IF NOT EXISTS markups_store_kind_idx
  ON markups (store_id, kind);
CREATE INDEX IF NOT EXISTS markups_store_created_idx
  ON markups (store_id, created_at_ms DESC, id DESC);

-- ---- customizations, order links and cleanup bookkeeping -----------------------------------------

CREATE TABLE IF NOT EXISTS customizations (
  id                   TEXT PRIMARY KEY,
  store_id             TEXT NOT NULL,
  config_id            TEXT NOT NULL,
  config_version       INTEGER NOT NULL,
  product_external_id  TEXT NOT NULL CHECK (length(product_external_id) BETWEEN 1 AND 200),
  variant_external_id  TEXT CHECK (variant_external_id IS NULL OR length(variant_external_id) BETWEEN 1 AND 200),
  mapping_scope        TEXT NOT NULL CHECK (mapping_scope IN ('product', 'variant', 'collection')),
  mapping_external_id  TEXT NOT NULL CHECK (length(mapping_external_id) BETWEEN 1 AND 200),
  status               TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'ordered', 'expired')),
  data                 TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  -- Not business state: how many of the assets requested in the IN-FLIGHT attach call are still
  -- unclaimed. Set fresh by every save()/update() attach attempt before it claims anything; see the
  -- trigger pair at the bottom of this file. Never read by the application.
  pending_attach_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at           TEXT,
  ordered_at           TEXT,
  expired_at           TEXT,
  created_at_ms        INTEGER NOT NULL,
  updated_at_ms        INTEGER NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT customizations_version_fk FOREIGN KEY (config_id, store_id, config_version)
    REFERENCES config_versions (config_id, store_id, version) ON DELETE RESTRICT,
  CONSTRAINT customizations_id_store_uq UNIQUE (id, store_id),
  CONSTRAINT customizations_state_chk CHECK (
       (status = 'saved'   AND expires_at IS NOT NULL AND ordered_at IS NULL AND expired_at IS NULL)
    OR (status = 'ordered' AND ordered_at IS NOT NULL AND expires_at IS NULL AND expired_at IS NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL AND expires_at IS NULL AND ordered_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS customizations_store_created_idx
  ON customizations (store_id, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS customizations_store_status_idx
  ON customizations (store_id, status, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS customizations_expiry_idx
  ON customizations (expires_at) WHERE status = 'saved';
CREATE INDEX IF NOT EXISTS customizations_purge_idx
  ON customizations (expired_at) WHERE status = 'expired';
CREATE INDEX IF NOT EXISTS customizations_config_idx
  ON customizations (config_id, store_id, config_version);
CREATE INDEX IF NOT EXISTS customizations_product_idx
  ON customizations (store_id, product_external_id);

CREATE TABLE IF NOT EXISTS customization_assets (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT NOT NULL,
  customization_id   TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('upload', 'preview', 'artwork')),
  object_key         TEXT NOT NULL UNIQUE,
  original_filename  TEXT,
  content_type       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  width              INTEGER,
  height             INTEGER,
  checksum_sha256    TEXT,
  status             TEXT NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded', 'attached', 'released', 'deleting', 'deleted')),
  delete_after       TEXT,
  delete_attempts    INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attached_at        TEXT,
  deleted_at         TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT customization_assets_owner_fk FOREIGN KEY (customization_id, store_id)
    REFERENCES customizations (id, store_id) ON DELETE CASCADE,
  CONSTRAINT customization_assets_owner_chk CHECK (
       (status = 'uploaded' AND customization_id IS NULL)
    OR (status = 'attached' AND customization_id IS NOT NULL)
    OR status IN ('released', 'deleting', 'deleted')
  )
);

CREATE INDEX IF NOT EXISTS customization_assets_owner_idx
  ON customization_assets (customization_id);
CREATE INDEX IF NOT EXISTS customization_assets_release_idx
  ON customization_assets (delete_after) WHERE status = 'released';
CREATE INDEX IF NOT EXISTS customization_assets_unattached_idx
  ON customization_assets (created_at) WHERE status = 'uploaded';
CREATE INDEX IF NOT EXISTS customization_assets_deleting_idx
  ON customization_assets (updated_at) WHERE status = 'deleting';

CREATE TABLE IF NOT EXISTS order_links (
  id                   TEXT PRIMARY KEY,
  store_id             TEXT NOT NULL,
  customization_id     TEXT NOT NULL,
  external_order_id    TEXT NOT NULL CHECK (length(external_order_id) BETWEEN 1 AND 200),
  external_line_id     TEXT NOT NULL CHECK (length(external_line_id) BETWEEN 1 AND 200),
  product_external_id  TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_links_customization_fk FOREIGN KEY (customization_id, store_id)
    REFERENCES customizations (id, store_id) ON DELETE RESTRICT,
  CONSTRAINT order_links_customization_uq UNIQUE (customization_id),
  CONSTRAINT order_links_line_uq UNIQUE (store_id, external_order_id, external_line_id)
);

CREATE INDEX IF NOT EXISTS order_links_order_idx
  ON order_links (store_id, external_order_id);

-- `status` lets a crashed or concurrently-retried event be safely re-run: 'processing' means "don't
-- trust `results` yet, re-apply every line" (each line's own write is already conditional, so
-- re-applying an already-applied line is a safe no-op); 'completed' means `results` is final truth for
-- replay. See order-callback-service.ts.
CREATE TABLE IF NOT EXISTS integration_events (
  store_id           TEXT NOT NULL,
  event_id           TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  event_type         TEXT NOT NULL,
  payload_sha256     TEXT NOT NULL,
  external_order_id  TEXT,
  line_count         INTEGER,
  status             TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  results            TEXT CHECK (results IS NULL OR json_valid(results)),
  credential_id      TEXT,
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  request_id         TEXT,
  PRIMARY KEY (store_id, event_id)
);

CREATE TABLE IF NOT EXISTS cleanup_runs (
  id                       TEXT PRIMARY KEY,
  trigger                  TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at              TEXT,
  customizations_expired   INTEGER NOT NULL DEFAULT 0,
  uploads_released         INTEGER NOT NULL DEFAULT 0,
  assets_deleted           INTEGER NOT NULL DEFAULT 0,
  assets_failed            INTEGER NOT NULL DEFAULT 0,
  tombstones_purged        INTEGER NOT NULL DEFAULT 0,
  error                    TEXT
);

CREATE INDEX IF NOT EXISTS cleanup_runs_started_idx
  ON cleanup_runs (started_at DESC);

-- ---- attach-count guard ----------------------------------------------------------------------------
--
-- Replaces the Postgres "insert a customization, conditionally claim N uploads, roll back both if the
-- claim came up short" transaction. D1's batch() is one atomic unit with no mid-batch branching, so the
-- all-or-nothing rule is enforced in SQL instead of app code:
--
--   1. The caller sets customizations.pending_attach_count to the number of uploads it is about to
--      attempt to claim (on INSERT for save(), or an explicit UPDATE for update()) as the first
--      statement(s) of the batch.
--   2. The claim UPDATE on customization_assets (status: 'uploaded' -> 'attached') runs next. Every row
--      it actually claims fires the trigger below, decrementing the counter by exactly the number of
--      rows claimed — if 2 of 3 requested uploads were claimable, the counter lands on 1, not 0.
--   3. The batch's last statement is a no-op touch (`UPDATE customizations SET updated_at = updated_at
--      WHERE id = ?`) that exists purely to fire the second trigger, which aborts the WHOLE batch — the
--      claim and the customization write together — if the counter isn't exactly 0.
--
-- No compensating delete/release is ever issued: on a shortfall nothing commits at all.
CREATE TRIGGER IF NOT EXISTS customization_assets_attach_decrement
AFTER UPDATE OF status ON customization_assets
WHEN NEW.status = 'attached' AND OLD.status = 'uploaded' AND NEW.customization_id IS NOT NULL
BEGIN
  UPDATE customizations SET pending_attach_count = pending_attach_count - 1
   WHERE id = NEW.customization_id;
END;

CREATE TRIGGER IF NOT EXISTS customizations_attach_guard
AFTER UPDATE OF updated_at ON customizations
WHEN NEW.pending_attach_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'attach_count_mismatch: one or more requested uploads could not be claimed');
END;
