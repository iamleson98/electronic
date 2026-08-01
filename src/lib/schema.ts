// Drizzle ORM schema — SQLite database.
// ─────────────────────────────────────────────────────────────────────────────
// Defines the `savedCircuits` table used by the circuit-save/load API.
// Migrated from Prisma (only the `SavedCircuit` model was actually used;
// the unused `User` and `Post` models were dropped during migration).
//
// Run `npm run db:push` to sync this schema into the SQLite file at `db/custom.db`.

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Saved user circuit (a serialized `CircuitDocument`).
 *
 * `document` stores the full circuit as a JSON string — components, wires,
 * sheets, drawings, etc. Kept as TEXT because SQLite has no native JSON type.
 */
export const savedCircuits = sqliteTable(
  'saved_circuits',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    document: text('document').notNull(),
    tags: text('tags').notNull().default(''),
    isExample: integer('is_example', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('saved_circuits_name_idx').on(table.name),
    index('saved_circuits_updated_at_idx').on(table.updatedAt),
  ],
);

/** TypeScript row type for SELECT * — Date fields are real `Date` objects. */
export type SavedCircuit = typeof savedCircuits.$inferSelect;

/** TypeScript row type for INSERT — `id`/timestamps are auto-generated. */
export type NewSavedCircuit = typeof savedCircuits.$inferInsert;
