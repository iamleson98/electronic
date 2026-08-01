// Drizzle ORM database client — SQLite via better-sqlite3.
// ─────────────────────────────────────────────────────────────────────────────
// Exports a singleton `db` instance that API routes import as `import { db } from '@/lib/db'`.
//
// The underlying SQLite file lives at `db/custom.db` (see `.env` → `DATABASE_URL`).
// In development, the client is cached on `globalThis` so Next.js hot-reload
// doesn't open a new connection on every code change.

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { savedCircuits } from './schema';

// Resolve the SQLite file path from `DATABASE_URL` (format: `file:/abs/path/custom.db`).
// Fall back to the project-relative `db/custom.db`.
const dbPath = (process.env.DATABASE_URL ?? 'file:./db/custom.db')
  .replace(/^file:/, '')
  .replace(/^\.\//, `${process.cwd()}/`);

const globalForDb = globalThis as unknown as {
  __drizzleDb: ReturnType<typeof createDb> | undefined;
};

function createDb() {
  const sqlite = new Database(dbPath);
  // WAL mode = better concurrency for read-heavy workloads (the API mostly reads).
  sqlite.pragma('journal_mode = WAL');
  return drizzle(sqlite, { schema: { savedCircuits } });
}

export const db = globalForDb.__drizzleDb ?? createDb();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__drizzleDb = db;
}
