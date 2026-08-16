// Drizzle ORM database client — Turso (libsql) in production, local SQLite in dev.
// ─────────────────────────────────────────────────────────────────────────────
// Exports:
//   - `getDb()` — async getter that returns the initialized Drizzle instance.
//                 API routes do `const db = await getDb();` then use `db.select(...)` etc.
//   - `dbReady` — the init promise (resolved when the DB is ready).
//
// Provider selection (in priority order):
//   1. TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  → Turso (libsql) — production
//   2. DATABASE_URL=file:./db/custom.db        → local better-sqlite3 — dev
//   3. No env vars                               → local better-sqlite3 — dev fallback
//
// The client is cached on `globalThis` so Next.js hot-reload doesn't open a
// new connection on every code change.
//
// Auto-creates the `saved_circuits` table if missing — makes the app
// self-bootstrapping in fresh environments (CI, new Vercel deployment, etc.)
// without requiring `drizzle-kit push` to be run first.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { savedCircuits } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Provider selection
// ─────────────────────────────────────────────────────────────────────────────

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LOCAL_DB_PATH = (() => {
  const raw = (process.env.DATABASE_URL ?? 'file:./db/custom.db').replace(/^file:/, '');
  if (!raw.startsWith('/')) {
    return `${process.cwd()}/${raw.replace(/^\.\//, '')}`;
  }
  return raw;
})();

const USE_TURSO = !!TURSO_URL && !!TURSO_TOKEN;

const globalForDb = globalThis as unknown as {
  __drizzleDb: any | undefined;
  __sqliteInstance: any | undefined;
  __dbPromise: Promise<any> | undefined;
  __shutdownRegistered: boolean | undefined;
};

async function createDb() {
  // During `next build`, Next.js evaluates route modules to collect page data.
  // Skip DB connection at build time — the real DB is only needed at runtime.
  if (process.env.NEXT_BUILD === 'true' || process.env.NEXT_PHASE === 'phase-production-build') {
    return { stub: true } as any;
  }

  if (USE_TURSO) {
    // ── Turso (libsql) — production ──────────────────────────────────────
    const { createClient } = await import('@libsql/client');
    const { drizzle } = await import('drizzle-orm/libsql');
    const client = createClient({
      url: TURSO_URL!,
      authToken: TURSO_TOKEN!,
    });
    // Auto-create the schema if missing.
    await client.execute(`
      CREATE TABLE IF NOT EXISTS saved_circuits (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        document TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        is_example INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    await client.execute(`CREATE INDEX IF NOT EXISTS saved_circuits_name_idx ON saved_circuits (name);`);
    await client.execute(`CREATE INDEX IF NOT EXISTS saved_circuits_updated_at_idx ON saved_circuits (updated_at);`);
    const db = drizzle(client, { schema: { savedCircuits } });
    globalForDb.__sqliteInstance = client;
    return db;
  }

  // ── Local better-sqlite3 — development ────────────────────────────────
  const Database = (await import('better-sqlite3')).default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  try {
    mkdirSync(dirname(LOCAL_DB_PATH), { recursive: true });
  } catch {
    // Read-only env — let better-sqlite3 throw a descriptive error below.
  }
  const sqlite = new Database(LOCAL_DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS saved_circuits (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      document TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      is_example INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS saved_circuits_name_idx ON saved_circuits (name);
    CREATE INDEX IF NOT EXISTS saved_circuits_updated_at_idx ON saved_circuits (updated_at);
  `);
  globalForDb.__sqliteInstance = sqlite;
  const db = drizzle(sqlite, { schema: { savedCircuits } });
  return db;
}

// Init promise — cached on globalThis so hot-reload doesn't re-init.
// Re-evaluated by getDb() so tests can clear the cache.
function initDb(): Promise<any> {
  if (globalForDb.__dbPromise) return globalForDb.__dbPromise;
  const p = (async () => {
    if (globalForDb.__drizzleDb) return globalForDb.__drizzleDb;
    const db = await createDb();
    if (process.env.NODE_ENV !== 'production') {
      globalForDb.__drizzleDb = db;
    }
    return db;
  })();
  globalForDb.__dbPromise = p;
  return p;
}

// For backward compat — module-level export that triggers init on first import.
export const dbReady: Promise<any> = initDb();

/**
 * Get the initialized Drizzle DB instance. API routes should do:
 *   const db = await getDb();
 *   const rows = await db.select(...)...
 *
 * For local better-sqlite3 (dev), this resolves synchronously. For Turso
 * (production), this awaits the libsql client init (~10ms on warm cache).
 */
export async function getDb(): Promise<any> {
  return initDb();
}

// Graceful shutdown — close the connection cleanly on process exit.
if (!globalForDb.__shutdownRegistered) {
  globalForDb.__shutdownRegistered = true;
  const shutdown = () => {
    try {
      globalForDb.__sqliteInstance?.close?.();
    } catch {
      // Ignore errors during shutdown
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
