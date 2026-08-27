// Drizzle ORM database client — Turso (libsql).
// ─────────────────────────────────────────────────────────────────────────────
// Exports:
//   - `getDb()` — async getter that returns the initialized Drizzle instance.
//   - `dbReady` — the init promise (resolved when the DB is connected).
//   - `runMigrations()` — applies pending drizzle migrations. Called from
//      src/instrumentation.ts on server startup so the first request after a
//      deploy doesn't pay the migration cost.
//
// Requires two env vars:
//   TURSO_DATABASE_URL  — e.g. libsql://your-db.turso.io
//   TURSO_AUTH_TOKEN    — the Turso auth token
//
// Migrations live in ./drizzle/. The __drizzle_migrations table tracks applied
// migrations so each only runs once (idempotent across deploys).
//
// After applying pending migrations, runMigrations() also rebuilds the derived
// tag/FTS indexes (circuit_tags + circuits_fts) from the TEXT `tags` column —
// see src/lib/circuits-service.ts. That backfill is idempotent and doubles as
// a self-heal: the TEXT column is the source of truth.
//
// During `next build`, returns a no-op stub — the real DB is only needed at
// runtime when API routes handle requests.

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { resolve } from 'node:path';
import { savedCircuits } from './schema';
import { rebuildTagsAndFts } from './circuits-service';

// ─────────────────────────────────────────────────────────────────────────────
// Config — read env vars lazily so tests can override them.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

const globalForDb = globalThis as unknown as {
  __drizzleDb: ReturnType<typeof createDrizzleDb> | undefined;
  __libsqlClient: ReturnType<typeof createClient> | undefined;
  __dbPromise: Promise<ReturnType<typeof createDrizzleDb>> | undefined;
  __migrationsPromise: Promise<void> | undefined;
  __migrationsApplied: boolean | undefined;
  __shutdownRegistered: boolean | undefined;
};

function createDrizzleDb() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  const db = drizzle(client, { schema: { savedCircuits } });
  globalForDb.__libsqlClient = client;
  return db;
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
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      // Defer to initDb()'s error message
      return;
    }
    const db = createDrizzleDb();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    // Backfill/self-heal the derived tag + FTS tables from the TEXT tags
    // column (idempotent — delete + reinsert per circuit; see
    // circuits-service.ts). Best-effort: a failure here must not break
    // startup — reads degrade to LIKE filters and the next deploy retries.
    if (globalForDb.__libsqlClient) {
      try {
        await rebuildTagsAndFts(globalForDb.__libsqlClient);
      } catch (backfillErr) {
        console.error('[db] tags/FTS backfill failed (will retry next start):', backfillErr);
      }
    }
    globalForDb.__migrationsApplied = true;
    if (process.env.NODE_ENV !== 'production') {
      globalForDb.__drizzleDb = db;
    }
  })();

  return globalForDb.__migrationsPromise;
}

async function initDb(): Promise<ReturnType<typeof createDrizzleDb>> {
  if (globalForDb.__dbPromise) return globalForDb.__dbPromise;

  globalForDb.__dbPromise = (async () => {
    // During `next build`, return a stub — the real DB is only needed at runtime.
    if (process.env.NEXT_BUILD === 'true' || process.env.NEXT_PHASE === 'phase-production-build') {
      return { stub: true } as any;
    }

    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      throw new Error(
        'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN. ' +
        'Set these env vars in .env (local) or Vercel Project Settings (production).',
      );
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
  })();

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
if (!globalForDb.__shutdownRegistered) {
  globalForDb.__shutdownRegistered = true;
  const shutdown = () => {
    try {
      globalForDb.__libsqlClient?.close();
    } catch {
      // Ignore errors during shutdown
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
