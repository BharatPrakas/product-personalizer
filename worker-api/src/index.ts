/**
 * Worker entry point. Builds the Hono app once per isolate and delegates `fetch` to it. The cron
 * trigger (see wrangler.jsonc `triggers`) runs the cleanup of abandoned customizations and customer
 * files.
 */

import { createApp } from './app';
import type { Env } from './config/environment';
import { runScheduledCleanup } from './scheduled';

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduledCleanup(env, controller.cron));
  },
} satisfies ExportedHandler<Env>;
