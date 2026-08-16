// Drizzle Kit configuration.
// Used by `drizzle-kit push` / `generate` / `migrate` / `studio` to sync
// the schema in `src/lib/schema.ts` against the Turso (libsql) database.
//
// Requires:
//   TURSO_DATABASE_URL  — e.g. libsql://your-db.turso.io
//   TURSO_AUTH_TOKEN    — the Turso auth token

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  },
  verbose: true,
  strict: true,
});
