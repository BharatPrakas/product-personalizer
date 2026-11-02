-- Migration 0004 — Per-store integration credentials (platform schema).
--
-- Server-to-server callers (for example ZenBasket's order service) authenticate with a per-store HMAC
-- secret. The secret must be recoverable by the Worker to verify signatures, so it is stored
-- ENCRYPTED (AES-256-GCM, see src/platform/integration-credentials/crypto.ts), never hashed and never
-- in the general-purpose `store_plugins.settings` jsonb. The master key lives only in a Worker secret
-- (`INTEGRATION_ENCRYPTION_KEY`); the plaintext secret is shown once, at creation, to the caller.
--
-- Several credentials may be live per (store, plugin) at once: that is how rotation works — issue a
-- new one, then let the old one lapse (`expires_at`) or revoke it.

CREATE TABLE IF NOT EXISTS platform.integration_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          text NOT NULL,
  plugin_id         text NOT NULL,
  label             text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
  -- `v1.<iv>.<tag>.<ciphertext>` (base64url), bound to (store_id, id) as AEAD associated data.
  secret_encrypted  text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Set on the OLD credential when it is rotated: it stays valid until then. NULL = no expiry.
  expires_at        timestamptz,
  revoked_at        timestamptz,
  last_used_at      timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_credentials_install_fk FOREIGN KEY (store_id, plugin_id)
    REFERENCES platform.store_plugins (store_id, plugin_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS integration_credentials_store_idx
  ON platform.integration_credentials (store_id, plugin_id, status);
