/**
 * Worker entry point. Builds the Hono app once per isolate and delegates `fetch` to it.
 */

import { createApp } from './app';
import type { Env } from './config/environment';

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
