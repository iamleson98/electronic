// Drizzle ORM database client — Turso (libsql).
// ─────────────────────────────────────────────────────────────────────────────
// Exports:
//   - `getDb()` — async getter that returns the initialized Drizzle instance.
//   - `dbReady` — the init promise (resolved when migrations are applied).
//
// Requires two env vars:
//   TURSO_DATABASE_URL  — e.g. libsql://your-db.turso.io
//   TURSO_AUTH_TOKEN    — the Turso auth token
//
// On startup, drizzle's migrate() applies any pending migration files from
// ./drizzle/. The __drizzle_migrations table tracks applied migrations so
// each only runs once (idempotent across deploys).
//
// During `next build`, returns a no-op stub — the real DB is only needed at
// runtime when API routes handle requests.

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { resolve } from 'node:path';
import { savedCircuits } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Config — read env vars lazily so tests can override them.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

const globalForDb = globalThis as unknown as {
  __drizzleDb: ReturnType<typeof createDrizzleDb> | undefined;
  __libsqlClient: ReturnType<typeof createClient> | undefined;
  __dbPromise: Promise<ReturnType<typeof createDrizzleDb>> | undefined;
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

    const db = createDrizzleDb();

    // Run pending migrations — creates the schema if missing, applies any
    // new migrations added in future deploys. Idempotent: tracks applied
    // migrations in the __drizzle_migrations table.
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    if (process.env.NODE_ENV !== 'production') {
      globalForDb.__drizzleDb = db;
    }
    return db;
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
