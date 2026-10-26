-- Migration 0001 — Shared platform schema.
--
-- Owns cross-plugin infrastructure only: the plugin catalogue, per-store plugin installations, and
-- an append-only audit log. It deliberately does NOT own users or stores: those live in ZenBasket's
-- existing identity system (separate MySQL database, never touched here). We reference stores by
-- their stable EXTERNAL id as a text column — no foreign key into a local stores table.
--
-- Safe to re-run: every object is guarded with IF NOT EXISTS. `gen_random_uuid()` is built in on
-- PostgreSQL 13+ (no extension required).

CREATE SCHEMA IF NOT EXISTS platform;

-- Catalogue of plugins that can run on this shared backend. `plugin_id` is the stable identifier
-- used in URLs and table ownership (e.g. 'personalization').
CREATE TABLE IF NOT EXISTS platform.plugin_registry (
  plugin_id     text PRIMARY KEY CHECK (plugin_id ~ '^[a-z][a-z0-9_-]{1,62}$'),
  display_name  text NOT NULL,
  version       text NOT NULL DEFAULT '1.0.0',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deprecated')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Which plugins are installed/enabled for a given store (tenant). `store_id` is the external id.
CREATE TABLE IF NOT EXISTS platform.store_plugins (
  store_id      text NOT NULL,
  plugin_id     text NOT NULL REFERENCES platform.plugin_registry (plugin_id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS store_plugins_plugin_idx
  ON platform.store_plugins (plugin_id, status);

-- Append-only audit trail of privileged operations. Never stores secrets, tokens or payload bodies —
-- only identifiers, the action, and small structured metadata (counts, ids).
CREATE TABLE IF NOT EXISTS platform.audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    text,
  store_id      text,
  plugin_id     text,
  actor         text,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_store_idx  ON platform.audit_logs (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_plugin_idx ON platform.audit_logs (plugin_id, created_at DESC);
