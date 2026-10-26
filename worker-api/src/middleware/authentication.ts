/**
 * Authentication. The store/tenant identity is derived ONLY from a verified credential:
 *
 *  - Production/staging: an HS256 session token issued by the hosting platform (ZenBasket), signed
 *    with a shared secret (JWT_SIGNING_SECRET). The store id is a signed claim.
 *  - Development only: a static bearer token (DEV_AUTH_TOKEN) mapped to DEV_STORE_ID, so the stack
 *    can be exercised locally without standing up an identity provider. Never enabled in production.
 *
 * A client-supplied store/tenant id in a header, query param or body is NEVER trusted.
 *
 * NOTE: there is no production identity provider in this repository. This middleware defines the
 * integration boundary; wiring a real IdP means issuing tokens signed with JWT_SIGNING_SECRET (or
 * replacing `verifyJwtHs256` with the provider's verifier). Until a secret is configured, protected
 * routes reject every request, so no data operation is ever unauthenticated.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthPrincipal } from '../shared/context';
import { UnauthorizedError } from '../shared/errors';
import { scopesFromClaims, verifyJwtHs256 } from '../shared/jwt';

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.get('config');
  const token = bearer(c.req.header('authorization'));
  if (!token) throw new UnauthorizedError('A Bearer token is required.');

  // Development static token.
  if (config.devAuthToken && config.environment !== 'production' && token === config.devAuthToken) {
    if (!config.devStoreId) {
      throw new UnauthorizedError('DEV_AUTH_TOKEN is set but DEV_STORE_ID is not.');
    }
    const principal: AuthPrincipal = {
      storeId: config.devStoreId,
      subject: 'dev',
      scopes: ['*'],
      tokenType: 'dev',
    };
    c.set('auth', principal);
    await next();
    return;
  }

  if (!config.jwtSigningSecret) {
    throw new UnauthorizedError('Authentication is not configured on this environment.');
  }
  const result = await verifyJwtHs256(token, config.jwtSigningSecret);
  if (!result.ok) throw new UnauthorizedError(`Invalid token: ${result.reason}.`);

  const storeId = result.claims.store_id ?? result.claims.storeId;
  if (typeof storeId !== 'string' || storeId.length === 0) {
    throw new UnauthorizedError('Token does not identify a store.');
  }
  const principal: AuthPrincipal = {
    storeId,
    subject: typeof result.claims.sub === 'string' ? result.claims.sub : null,
    scopes: scopesFromClaims(result.claims),
    tokenType: 'jwt',
  };
  c.set('auth', principal);
  await next();
};
