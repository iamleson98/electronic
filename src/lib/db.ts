// Drizzle ORM database client — Turso (libsql) or local SQLite file.
// ─────────────────────────────────────────────────────────────────────────────
// Exports:
//   - `getDb()` — async getter that returns the initialized Drizzle instance.
//   - `dbReady` — the init promise (resolved when the DB is connected).
//   - `runMigrations()` — applies pending drizzle migrations. Called from
//      src/instrumentation.ts on server startup so the first request after a
//      deploy doesn't pay the migration cost.
//
// Database URL resolution (see resolveDbConfig below):
//   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  → remote Turso (production)
//   DATABASE_URL=file:…                    → local libsql file (dev)
//   file:./db/custom.db                    → local default (dev)
//
// Migrations live in ./drizzle/. The __drizzle_migrations table tracks applied
// migrations so each only runs once (idempotent across deploys). If the schema
// was created by `drizzle-kit push` instead (local dev bootstrap), the
// migrator baselines itself — see baselineIfPushed().
//
// After applying pending migrations, runMigrations() also rebuilds the derived
// tag/FTS indexes (circuit_tags + circuits_fts) from the TEXT `tags` column —
// see src/lib/circuits-service.ts. That backfill is idempotent and doubles as
// a self-heal: the TEXT column is the source of truth.
//
// During `next build`, returns a no-op stub — the real DB is only needed at
// runtime when API routes handle requests.

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { savedCircuits } from './schema';
import { rebuildTagsAndFts } from './circuits-service';

// ─────────────────────────────────────────────────────────────────────────────
// Config — read env vars lazily so tests can override them.
//
// Resolution order:
//   1. TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  — remote Turso (production)
//   2. TURSO_DATABASE_URL alone               — remote libsql without auth
//   3. DATABASE_URL                            — local libsql file (dev)
//   4. file:./db/custom.db                     — local default (dev)
//
// `file:` URLs are plain local SQLite — no auth token needed — so local
// development works out of the box without any Turso credentials.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

interface DbConfig {
  url: string;
  authToken?: string;
}

function resolveDbConfig(): DbConfig {
  const url =
    process.env.TURSO_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'file:./db/custom.db';
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
  // file: URLs never need an auth token; passing one is harmless but noisy.
  if (url.startsWith('file:')) return { url };
  return { url, authToken };
}

const globalForDb = globalThis as unknown as {
  __drizzleDb: ReturnType<typeof createDrizzleDb> | undefined;
  __libsqlClient: ReturnType<typeof createClient> | undefined;
  __dbPromise: Promise<ReturnType<typeof createDrizzleDb>> | undefined;
  __migrationsPromise: Promise<void> | undefined;
  __migrationsApplied: boolean | undefined;
  __shutdownRegistered: boolean | undefined;
};

function createDrizzleDb(client?: Client) {
  const c = client ?? (() => {
    const { url, authToken } = resolveDbConfig();
    return createClient(authToken ? { url, authToken } : { url });
  })();
  const db = drizzle(c, { schema: { savedCircuits } });
  globalForDb.__libsqlClient = c;
  return db;
}

/**
 * Self-heal the `drizzle-kit push` ↔ `migrate()` conflict.
 *
 * Local bootstrap (`.zscripts/dev.sh`) syncs the schema with
 * `drizzle-kit push`, which creates the tables WITHOUT recording anything
 * in `__drizzle_migrations`. The migrator would then fail with
 * "table `saved_circuits` already exists".
 *
 * Fix: when the schema already exists but no migrations are recorded,
 * insert every journal entry into `__drizzle_migrations` (baselining), so
 * `migrate()` cleanly skips them and only applies genuinely new ones.
 */
async function baselineIfPushed(client: Client): Promise<void> {
  const schemaExists = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='saved_circuits'",
  );
  if (schemaExists.rows.length === 0) return; // fresh DB — migrate() creates everything

  const migrationsTableExists = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
  );
  let recorded = 0;
  if (migrationsTableExists.rows.length > 0) {
    const rows = await client.execute(
      'SELECT count(*) AS n FROM __drizzle_migrations',
    );
    recorded = Number((rows.rows[0] as { n?: number | string } | undefined)?.n ?? 0);
  }
  if (recorded > 0) return; // migrator tracks its own progress

  // Read the journal and re-derive each migration's recorded identity the
  // same way drizzle's migrator does: hash = sha256(<tag>.sql content),
  // created_at = journal `when` (see drizzle-orm/migrator.js readMigrationFiles).
  let entries: Array<{ tag: string; when: number }> = [];
  try {
    const journal = JSON.parse(
      readFileSync(resolve(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries?: Array<{ tag: string; when: number }> };
    entries = (journal.entries ?? []).map((e) => ({ tag: e.tag, when: e.when }));
  } catch {
    return; // no journal → nothing to baseline
  }
  if (entries.length === 0) return;

  await client.execute(
    'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)',
  );
  for (const e of entries) {
    let hash: string;
    try {
      hash = createHash('sha256')
        .update(readFileSync(resolve(MIGRATIONS_FOLDER, `${e.tag}.sql`), 'utf8'))
        .digest('hex');
    } catch {
      continue; // migration file missing — skip (migrate() will surface it)
    }
    await client.execute({
      sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      args: [hash, e.when],
    });
  }
  console.warn(`[db] baselined ${entries.length} migration(s) — schema was created by drizzle-kit push`);
}

/**
 * Run pending drizzle migrations.
 *
 * Called from src/instrumentation.ts on server startup so migrations happen
 * BEFORE any request is handled. If the instrumentation hook doesn't run
 * (e.g., in tests, or in a non-Next.js environment), `initDb()` falls back
 * to running migrations itself on first DB access.
 *
 * Safe to call multiple times — drizzle tracks applied migrations in the
 * __drizzle_migrations table and only runs new ones.
 */
export async function runMigrations(): Promise<void> {
  if (globalForDb.__migrationsApplied) return;
  if (globalForDb.__migrationsPromise) return globalForDb.__migrationsPromise;

  globalForDb.__migrationsPromise = (async () => {
    // Skip during build phase
    if (process.env.NEXT_BUILD === 'true' || process.env.NEXT_PHASE === 'phase-production-build') {
      globalForDb.__migrationsApplied = true;
      return;
    }
    const { url, authToken } = resolveDbConfig();
    const client = createClient(authToken ? { url, authToken } : { url });
    globalForDb.__libsqlClient = client;
    await baselineIfPushed(client);
    const db = createDrizzleDb(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    // Backfill/self-heal the derived tag + FTS tables from the TEXT tags
    // column (idempotent — delete + reinsert per circuit; see
    // circuits-service.ts). Best-effort: a failure here must not break
    // startup — reads degrade to LIKE filters and the next deploy retries.
    try {
      await rebuildTagsAndFts(client);
    } catch (backfillErr) {
      console.error('[db] tags/FTS backfill failed (will retry next start):', backfillErr);
    }
    globalForDb.__migrationsApplied = true;
    if (process.env.NODE_ENV !== 'production') {
      globalForDb.__drizzleDb = db;
    }
  })().catch((err) => {
    // Don't cache a failed migration run — let the next call retry
    // (e.g. a transient network error to Turso should not brick the
    // process for its entire lifetime).
    globalForDb.__migrationsPromise = undefined;
    throw err;
  });

  return globalForDb.__migrationsPromise;
}

async function initDb(): Promise<ReturnType<typeof createDrizzleDb>> {
  if (globalForDb.__dbPromise) return globalForDb.__dbPromise;

  globalForDb.__dbPromise = (async () => {
    // During `next build`, return a stub — the real DB is only needed at runtime.
    if (process.env.NEXT_BUILD === 'true' || process.env.NEXT_PHASE === 'phase-production-build') {
      return { stub: true } as any;
    }

    // If migrations haven't been applied yet (e.g., instrumentation hook
    // didn't run, or this is a test), apply them now as a fallback.
    if (!globalForDb.__migrationsApplied) {
      await runMigrations();
    }

    // Reuse the drizzle instance created by runMigrations if it exists,
    // otherwise create a new one.
    if (globalForDb.__drizzleDb) return globalForDb.__drizzleDb;
    return createDrizzleDb();
  })().catch((err) => {
    // Don't cache a rejected init — a later getDb() call retries instead of
    // returning the same failure forever.
    globalForDb.__dbPromise = undefined;
    throw err;
  });

  return globalForDb.__dbPromise;
}

export const dbReady: Promise<any> = initDb();
void dbReady.catch(() => { /* swallow — error surfaces on next getDb() call */ });

/**
 * Get the initialized Drizzle DB instance.
 *
 * API routes do:
 *   const db = await getDb();
 *   const rows = await db.select(...)...
 */
export async function getDb() {
  return initDb();
}

// Graceful shutdown — close the libsql client cleanly on process exit.
// NOTE: only registered on real SIGTERM/SIGINT; process.exit(0) would kill the
// Next.js dev server's other handlers if called from arbitrary contexts.
if (!globalForDb.__shutdownRegistered) {
  globalForDb.__shutdownRegistered = true;
  const shutdown = () => {
    try {
      globalForDb.__libsqlClient?.close();
    } catch {
      // Ignore errors during shutdown
    }
  };
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
}
