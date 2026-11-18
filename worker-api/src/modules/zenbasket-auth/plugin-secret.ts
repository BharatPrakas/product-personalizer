/**
 * The ZenBasket plugin-level shared secret, and the order-webhook key derived from it.
 *
 * ZenBasket generates ONE secret when this plugin is registered with the Plugin Platform and holds the
 * same value in its own credential store. The Worker only ever receives it as the Cloudflare secret
 * `ZB_PLUGIN_SECRET`; it never generates, stores (D1), logs or returns it.
 *
 * Two flows use it, with different keys:
 *  - merchant JWTs (HS256) are verified with the secret itself (middleware/authentication.ts);
 *  - order callbacks are verified with a key DERIVED from it with HKDF-SHA256 (RFC 5869):
 *
 *      key = HKDF-SHA256(ikm = utf8(ZB_PLUGIN_SECRET), salt = "", info = "zb-plugin:v1:order-webhook", L = 32)
 *
 * so a webhook signature can never be replayed as a merchant token or the other way round. The ZenBasket
 * sender MUST use the same `info` string; it is part of the integration contract
 * (docs/zenbasket-integration.md).
 */

/** A shorter value cannot be a ZenBasket-generated secret: it is treated as not configured. */
export const MIN_PLUGIN_SECRET_LENGTH = 32;

/** HKDF `info` for the order-webhook key. Fixed and versioned: changing it is a breaking change for the sender. */
export const WEBHOOK_KEY_INFO = 'zb-plugin:v1:order-webhook';

const encoder = new TextEncoder();

/** The secret trimmed, or null when it is missing or too short to be a real one. Never logs the value. */
export function normalizePluginSecret(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && value.length >= MIN_PLUGIN_SECRET_LENGTH ? value : null;
}

/** The 32-byte order-webhook signing key, derived from the root secret. */
export async function deriveWebhookKey(secret: string): Promise<Uint8Array> {
  const root = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(WEBHOOK_KEY_INFO) },
    root,
    256,
  );
  return new Uint8Array(bits);
}
