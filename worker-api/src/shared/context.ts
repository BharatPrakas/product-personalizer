/**
 * Shared Hono typing. `AppEnv` is the generic every router/middleware is parameterised with, so the
 * request context is fully typed (`c.get('auth')`, `c.get('db')`, ...).
 */

import type { AppConfig, Env } from '../config/environment';
import type { Database } from '../database/connection';
import type { Logger } from './logger';

/** Verified identity, derived ONLY from authenticated credentials — never from client-supplied ids. */
export interface AuthPrincipal {
  /** External (ZenBasket) store/tenant id. */
  storeId: string;
  /** Subject/user id when the token carries one. */
  subject: string | null;
  scopes: readonly string[];
  tokenType: 'jwt' | 'dev';
}

export interface TenantContext {
  storeId: string;
}

export interface AppVariables {
  requestId: string;
  config: AppConfig;
  logger: Logger;
  db: Database;
  auth: AuthPrincipal;
  tenant: TenantContext;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
