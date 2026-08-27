CREATE TABLE `circuit_tags` (
        `id` text PRIMARY KEY NOT NULL,
        `circuit_id` text NOT NULL,
        `tag` text NOT NULL,
        FOREIGN KEY (`circuit_id`) REFERENCES `saved_circuits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `circuit_tags_circuit_id_tag_idx` ON `circuit_tags` (`circuit_id`,`tag`);--> statement-breakpoint
CREATE INDEX `circuit_tags_tag_idx` ON `circuit_tags` (`tag`);--> statement-breakpoint
-- Full-text index over the searchable text of each saved circuit.
-- Flavor decision: a standalone (contentful) FTS5 table with an UNINDEXED
-- `circuit_id` column, maintained by the application (INSERT after DELETE on
-- every write — see src/lib/circuits-service.ts). Chosen over:
--   * external-content (`content='saved_circuits'`): needs an integer
--     content_rowid, but saved_circuits' PK is a TEXT uuid (the implicit rowid
--     would work but is invisible to Drizzle and fragile);
--   * contentless-delete (`content=''`): deletes require the special
--     'delete' command with the EXACT previously-indexed values — easy to
--     corrupt, and needs SQLite >= 3.43.
-- A standalone table supports plain `DELETE ... WHERE circuit_id = ?`, and the
-- storage duplication (name+description+tags only — never the big `document`
-- JSON blob) is negligible. The `tags` column mirrors the canonical TEXT
-- column; the unicode61 tokenizer splits it into per-tag tokens anyway.
-- Backfill of both circuit_tags and circuits_fts from existing rows is done
-- in JS after this migration runs (src/lib/db.ts runMigrations), because the
-- tag-splitting rules live in src/lib/tags.ts.
CREATE VIRTUAL TABLE `circuits_fts` USING fts5(`name`, `description`, `tags`, `circuit_id` UNINDEXED);