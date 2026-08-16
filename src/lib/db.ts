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
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  // Ensure the parent directory exists — fresh checkouts (CI, new clones) won't
  // have `db/` yet, and better-sqlite3 throws if the directory is missing.
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // Directory creation may fail in read-only environments; let better-sqlite3
    // throw a more descriptive error below in that case.
  }
  const sqlite = new Database(dbPath);
  // WAL mode = better concurrency for read-heavy workloads (the API mostly reads).
  sqlite.pragma('journal_mode = WAL');
  // Enable foreign keys (good practice even though we have no FKs currently).
  sqlite.pragma('foreign_keys = ON');
  // Auto-create the schema if missing — makes the app self-bootstrapping in
  // fresh environments (CI, new clones, container restarts with empty volumes)
  // without requiring `drizzle-kit push` to be run first.
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
