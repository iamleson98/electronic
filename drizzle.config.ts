// Drizzle Kit configuration.
// Used by `drizzle-kit push` / `generate` / `migrate` / `studio` to sync
// the schema in `src/lib/schema.ts` against the database.
//
// Provider selection (matches src/lib/db.ts):
//   1. TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  → Turso (libsql) — production
//   2. DATABASE_URL=file:./db/custom.db        → local better-sqlite3 — dev
//   3. No env vars                               → local better-sqlite3 — dev fallback

import { defineConfig } from 'drizzle-kit';

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const USE_TURSO = !!TURSO_URL && !!TURSO_TOKEN;

export default defineConfig({
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dialect: USE_TURSO ? 'turso' : 'sqlite',
  dbCredentials: USE_TURSO
    ? {
        url: TURSO_URL!,
        authToken: TURSO_TOKEN!,
      }
    : {
        url: process.env.DATABASE_URL?.replace(/^file:/, '') ?? './db/custom.db',
      },
  verbose: true,
  strict: true,
});
