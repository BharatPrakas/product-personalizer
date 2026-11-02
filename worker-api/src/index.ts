/**
 * Worker entry point. Builds the Hono app once per isolate and delegates `fetch` to it. The cron
 * trigger (see wrangler.jsonc `triggers`) runs every plugin's scheduled job, e.g. the personalization
 * cleanup of abandoned customizations.
 */

import { buildRegistry, createApp } from './app';
import { loadConfig, type Env } from './config/environment';
import { createDatabase } from './database/connection';
import { Logger } from './shared/logger';

const registry = buildRegistry();
const app = createApp(registry);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(env, controller.cron));
  },
} satisfies ExportedHandler<Env>;

/** One database connection per plugin job; a failing job never stops the others. */
async function runScheduled(env: Env, trigger: string): Promise<void> {
  const config = loadConfig(env);
  for (const plugin of registry.all()) {
    if (!plugin.scheduled) continue;
    const logger = new Logger(config.logLevel, { requestId: `cron-${crypto.randomUUID()}`, plugin: plugin.id });
    const db = createDatabase(env.HYPERDRIVE.connectionString);
    try {
      await plugin.scheduled({ env, config, db, logger, trigger });
    } catch (error) {
      logger.error('scheduled job failed', { error: String(error) });
    } finally {
      await db.close().catch(() => undefined);
    }
  }
}
