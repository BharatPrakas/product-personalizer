/**
 * Merchant authentication. The store/tenant identity is derived ONLY from a verified credential, never
 * from a client header, query param or body field.
 *
 * The credential is an HS256 session token issued by the hosting platform (ZenBasket) and signed with the
 * plugin-level secret `ZB_PLUGIN_SECRET` (see modules/zenbasket-auth). Its claims are
 * `{ storeId, pluginId, iat, exp }` (+ optional `sub`, `nbf`). The Worker requires:
 *
 *  - a valid HS256 signature (`alg` exactly HS256);
 *  - `iat` and `exp`, and the token not expired (a token with no expiry is refused);
 *  - `pluginId` equal to `ZB_PLUGIN_ID` (a token issued for another plugin is refused);
 *  - `storeId` naming a store; that is the tenant for the whole request.
 *
 * There is exactly one way in. No static token, no bypass flag, no second secret, no fallback: with no
 * usable `ZB_PLUGIN_SECRET` / `ZB_PLUGIN_ID` every protected route answers 401. Locally, use real signed
 * tokens (`npm run dev:token`).
 *
 * This is the MERCHANT flow only. Order callbacks are a separate flow (HMAC over the body, keyed by a key
 * derived from the same secret, see integration-controller.ts): a merchant token is not accepted there and a
 * callback signature is not accepted here.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthPrincipal } from '../shared/context';
import { UnauthorizedError } from '../shared/errors';
import { verifyJwtHs256, type JwtClaims } from '../shared/jwt';

/**
 * The store id claim as a string. ZenBasket signs it as a number (`{ storeId: 766 }`); a string is
 * accepted too and names the same store. Anything else (missing, empty, zero, negative, fractional, an
 * object ...) identifies no store.
 */
export function storeIdFromClaims(claims: JwtClaims): string | null {
  return idClaim(claims.storeId);
}

/** The plugin the token was issued for, as a string. Same rules as the store id claim. */
export function pluginIdFromClaims(claims: JwtClaims): string | null {
  return idClaim(claims.pluginId);
}

function idClaim(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.length > 0 ? raw : null;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  return null;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.get('config');

  const token = bearer(c.req.header('authorization'));
  if (!token) throw new UnauthorizedError('A Bearer token is required.');

  // Fail closed: without the plugin secret and plugin id nothing can be verified, so nothing is allowed.
  if (!config.zbPluginSecret || !config.zbPluginId) {
    c.get('logger').error('merchant authentication is not configured', {
      missing: [!config.zbPluginSecret && 'ZB_PLUGIN_SECRET', !config.zbPluginId && 'ZB_PLUGIN_ID'].filter(Boolean),
    });
    throw new UnauthorizedError('Authentication is not configured on this environment.');
  }
  const result = await verifyJwtHs256(token, config.zbPluginSecret);
  if (!result.ok) throw new UnauthorizedError(`Invalid token: ${result.reason}.`);

  // The signature proves ZenBasket issued it; these prove it was issued for THIS plugin and a store.
  if (pluginIdFromClaims(result.claims) !== config.zbPluginId) {
    throw new UnauthorizedError('Token was not issued for this plugin.');
  }
  const storeId = storeIdFromClaims(result.claims);
  if (!storeId) {
    throw new UnauthorizedError('Token does not identify a store.');
  }
  const principal: AuthPrincipal = {
    storeId,
    subject: typeof result.claims.sub === 'string' ? result.claims.sub : null,
    tokenType: 'jwt',
  };
  c.set('auth', principal);
  await next();
};
