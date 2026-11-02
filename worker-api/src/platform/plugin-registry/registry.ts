/**
 * In-code plugin registry: the modular route-registration mechanism that keeps the shared platform
 * independent of any single plugin's business logic. Each plugin is a `PluginModule` that mounts its
 * own routes onto a router it is handed. `app.ts` iterates the registry, guards each plugin with the
 * installation check, and mounts it under `/api/<version>/plugins/<id>`.
 *
 * Adding a future plugin = append a `PluginModule` here. Authentication, tenant handling, database
 * and storage infrastructure are reused unchanged.
 */

import type { Hono } from 'hono';
import type { AppConfig, Env } from '../../config/environment';
import type { Database } from '../../database/connection';
import type { Logger } from '../../shared/logger';
import type { AppEnv } from '../../shared/context';
import type { RateLimiter } from '../../shared/rate-limit';
import { assertStorageFolder } from '../../storage/object-storage';

/** Shared infrastructure handed to a plugin's PUBLIC (unauthenticated) routes. */
export interface PublicRouteDeps {
  rateLimiter: RateLimiter;
}

/** What a plugin's scheduled (cron) job receives. The database connection is closed by the caller. */
export interface ScheduledDeps {
  env: Env;
  config: AppConfig;
  db: Database;
  logger: Logger;
  /** The cron expression that fired, or 'manual'. */
  trigger: string;
}

export interface PluginModule {
  /** Stable identifier used in URLs and table ownership, e.g. 'personalization'. */
  id: string;
  displayName: string;
  version: string;
  /**
   * Folder under `stores/<store>/` where this plugin keeps its assets, e.g. 'product-personalization'.
   * Must be unique across plugins.
   */
  storageFolder: string;
  /** Mount the plugin's routes onto `router` (already scoped + auth/tenant/install-guarded). */
  register(router: Hono<AppEnv>): void;
  /**
   * Optional PUBLIC routes, mounted under `/api/<version>/storefront/<id>` with NO authentication or
   * tenant middleware. Handlers must derive everything from the request itself, validate it strictly
   * and never trust it to select data outside what is meant to be public.
   */
  registerPublic?(router: Hono<AppEnv>, deps: PublicRouteDeps): void;
  /**
   * Optional SERVER-TO-SERVER routes, mounted under `/api/<version>/integrations/<id>` with no Bearer
   * authentication or tenant middleware: each handler authenticates the caller itself (for example by
   * verifying a request signature) and derives the store from that proof, never from the request body.
   */
  registerIntegration?(router: Hono<AppEnv>, deps: PublicRouteDeps): void;
  /** Optional job run by the Worker's cron trigger (cleanup, reconciliation, ...). */
  scheduled?(deps: ScheduledDeps): Promise<void>;
}

export class PluginRegistry {
  private readonly modules = new Map<string, PluginModule>();

  register(module: PluginModule): this {
    if (this.modules.has(module.id)) {
      throw new Error(`Plugin "${module.id}" is already registered.`);
    }
    assertStorageFolder(module.storageFolder);
    for (const other of this.modules.values()) {
      if (other.storageFolder === module.storageFolder) {
        throw new Error(`Storage folder "${module.storageFolder}" is already used by plugin "${other.id}".`);
      }
    }
    this.modules.set(module.id, module);
    return this;
  }

  has(id: string): boolean {
    return this.modules.has(id);
  }

  get(id: string): PluginModule | undefined {
    return this.modules.get(id);
  }

  all(): readonly PluginModule[] {
    return [...this.modules.values()];
  }
}
