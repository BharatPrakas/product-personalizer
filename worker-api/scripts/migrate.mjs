#!/usr/bin/env node
/**
 * PostgreSQL migration runner.
 *
 * Runs from a trusted machine or CI — NEVER inside a Worker request (no destructive schema change
 * happens on the hot path). It applies every `migrations/NNNN_*.sql` file in order, each inside its
 * own transaction, and records it in `personalization.schema_migrations` with a checksum.
 *
 * Guarantees:
 *   - Idempotent: an already-applied migration is skipped.
 *   - Append-only: if a previously-applied file's checksum changed, it refuses to run (you must add a
 *     new migration instead of editing a shipped one).
 *   - It refuses a database created by the pre-baseline migrations (their ledger lived in the
 *     `platform` schema): such a database has to be dropped and recreated, not migrated in place.
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@host:5432/db node scripts/migrate.mjs           # apply pending
 *   DATABASE_URL=... node scripts/migrate.mjs status                                   # show state
 *
 * The connection string comes from DATABASE_URL (a trusted env var), not from the Worker bindings.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required, e.g. postgres://user:pass@127.0.0.1:5432/db');
    process.exit(1);
  }
  return url;
}

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { file, sql, checksum };
    });
}

async function assertNotPreBaseline(client) {
  const { rows } = await client.query("SELECT to_regclass('platform.schema_migrations') AS ledger");
  if (rows[0].ledger) {
    throw new Error(
      'This database was created by the pre-baseline migrations (platform.schema_migrations exists). ' +
        'Drop its "platform" and "personalization" schemas (or recreate the database) and run the migrations again.',
    );
  }
}

async function ensureTracking(client) {
  await assertNotPreBaseline(client);
  await client.query('CREATE SCHEMA IF NOT EXISTS personalization');
  await client.query(`
    CREATE TABLE IF NOT EXISTS personalization.schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMap(client) {
  const { rows } = await client.query('SELECT version, checksum FROM personalization.schema_migrations');
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

async function status(client) {
  await ensureTracking(client);
  const applied = await appliedMap(client);
  const migrations = loadMigrations();
  console.log('Migration status:');
  for (const m of migrations) {
    const prior = applied.get(m.file);
    const state = !prior ? 'PENDING' : prior === m.checksum ? 'applied' : 'CHECKSUM MISMATCH';
    console.log(`  ${state.padEnd(16)} ${m.file}`);
  }
  const pending = migrations.filter((m) => !applied.has(m.file)).length;
  console.log(`\n${pending} pending, ${applied.size} applied.`);
}

async function migrate(client) {
  await ensureTracking(client);
  const applied = await appliedMap(client);
  const migrations = loadMigrations();

  for (const m of migrations) {
    const prior = applied.get(m.file);
    if (prior) {
      if (prior !== m.checksum) {
        throw new Error(
          `Refusing to run: ${m.file} was already applied but its checksum changed. ` +
            `Shipped migrations are immutable — add a new migration instead.`,
        );
      }
      continue;
    }
    process.stdout.write(`Applying ${m.file} ... `);
    await client.query('BEGIN');
    try {
      await client.query(m.sql);
      await client.query(
        'INSERT INTO personalization.schema_migrations (version, checksum) VALUES ($1, $2)',
        [m.file, m.checksum],
      );
      await client.query('COMMIT');
      console.log('done');
    } catch (error) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw error;
    }
  }
  console.log('All migrations applied.');
}

async function main() {
  const command = process.argv[2] ?? 'up';
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    if (command === 'status') await status(client);
    else if (command === 'up') await migrate(client);
    else {
      console.error(`Unknown command "${command}". Use "up" or "status".`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('\nMigration failed:', error.message);
  process.exit(1);
});
