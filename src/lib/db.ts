// Drizzle ORM database client — SQLite via better-sqlite3.
// ─────────────────────────────────────────────────────────────────────────────
// Exports a singleton `db` instance that API routes import as `import { db } from '@/lib/db'`.
//
// The underlying SQLite file lives at `db/custom.db` (see `.env` → `DATABASE_URL`).
// In development, the client is cached on `globalThis` so Next.js hot-reload
// doesn't open a new connection on every code change.
//
// Graceful shutdown: on SIGTERM/SIGINT, the SQLite connection is closed cleanly
// so WAL data is checkpointed to the main database file.

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { savedCircuits } from './schema';

// Resolve the SQLite file path from `DATABASE_URL` (format: `file:/abs/path/custom.db`).
const dbPath = (process.env.DATABASE_URL ?? 'file:./db/custom.db')
  .replace(/^file:/, '')
  .replace(/^\.\//, `${process.cwd()}/`);

const globalForDb = globalThis as unknown as {
  __drizzleDb: ReturnType<typeof createDb> | undefined;
  __sqliteInstance: Database.Database | undefined;
  __shutdownRegistered: boolean | undefined;
};

function createDb() {
  const sqlite = new Database(dbPath);
  // WAL mode = better concurrency for read-heavy workloads (the API mostly reads).
  sqlite.pragma('journal_mode = WAL');
  // Enable foreign keys (good practice even though we have no FKs currently).
  sqlite.pragma('foreign_keys = ON');
  globalForDb.__sqliteInstance = sqlite;
  return drizzle(sqlite, { schema: { savedCircuits } });
}

export const db = globalForDb.__drizzleDb ?? createDb();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__drizzleDb = db;
}

// Graceful shutdown — close the SQLite connection cleanly on process exit.
// This ensures WAL data is checkpointed to the main database file.
if (!globalForDb.__shutdownRegistered) {
  globalForDb.__shutdownRegistered = true;
  const shutdown = () => {
    try {
      globalForDb.__sqliteInstance?.close();
    } catch {
      // Ignore errors during shutdown
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
