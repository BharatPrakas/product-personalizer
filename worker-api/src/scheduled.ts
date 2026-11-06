/**
 * The cron job. D1 has no per-request connection to open or close (unlike the old Hyperdrive/`pg`
 * client), so this is just a thin wrapper. A failing run is logged and never thrown into the runtime
 * (each run is also recorded in `cleanup_runs` by the service).
 */

import { loadConfig, type Env } from './config/environment';
import { createDatabase } from './database/connection';
import { CleanupService } from './modules/personalization/cleanup-service';
import { createObjectStorage } from './storage';
import { Logger } from './shared/logger';

export async function runScheduledCleanup(env: Env, trigger: string): Promise<void> {
  const config = loadConfig(env);
  const logger = new Logger(config.logLevel, { requestId: `cron-${crypto.randomUUID()}` });
  const db = createDatabase(env.DB);
  try {
    await new CleanupService({ db, storage: () => createObjectStorage(env, config), config, logger }).run(trigger);
  } catch (error) {
    logger.error('scheduled job failed', { error: String(error) });
  }
}
