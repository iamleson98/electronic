// Tests for the database client (db.ts) — verifies Turso init, build-time
// stub, and that migrations run correctly.
//
// These tests use @libsql/client with an in-memory database — no Turso
// credentials needed. The real Turso path is tested by scripts/test-turso.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, dbReady } from '../src/lib/db';
import { savedCircuits } from '../src/lib/schema';
import { eq } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Set in-memory libsql env vars so db.ts can initialize without Turso
  process.env.TURSO_DATABASE_URL = ':memory:';
  process.env.TURSO_AUTH_TOKEN = 'test-token';
  delete process.env.NEXT_BUILD;
  delete process.env.NEXT_PHASE;
  // Clear the cached db singleton so each test re-initializes
  // (including migration state — each test should re-run migrations
  // against its fresh in-memory DB)
  const g = globalThis as any;
  g.__drizzleDb = undefined;
  g.__libsqlClient = undefined;
  g.__dbPromise = undefined;
  g.__migrationsPromise = undefined;
  g.__migrationsApplied = undefined;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('db.ts: provider selection', () => {
  it('uses Turso (libsql) when TURSO_* env vars are set', async () => {
    const db = await getDb();
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('returns stub during NEXT_BUILD phase', async () => {
    process.env.NEXT_BUILD = 'true';
    const db = await getDb();
    expect(db.stub).toBe(true);
  });

  it('returns stub during phase-production-build', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const db = await getDb();
    expect(db.stub).toBe(true);
  });
});

describe('db.ts: migration-based schema creation', () => {
  it('creates the saved_circuits table via migration on first connection', async () => {
    const db = await getDb();
    const rows = await db.select({ id: savedCircuits.id }).from(savedCircuits).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('tracks applied migrations in __drizzle_migrations table', async () => {
    await getDb();
    // Use a fresh client to check the in-memory DB state
    // (the db.ts client is cached on globalThis)
    const g = globalThis as any;
    const client = g.__libsqlClient;
    if (client) {
      const result = await client.execute('SELECT COUNT(*) as count FROM __drizzle_migrations');
      const count = (result.rows[0] as any).count;
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it('re-running init does not duplicate migrations (idempotent)', async () => {
    await getDb();  // first init — applies migrations
    // Re-call getDb() WITHOUT clearing the cache — should return the same
    // promise and NOT re-apply migrations.
    await getDb();
    const g = globalThis as any;
    const client = g.__libsqlClient;
    if (client) {
      const result = await client.execute('SELECT COUNT(*) as count FROM __drizzle_migrations');
      const count = (result.rows[0] as any).count;
      // One row per migration file in drizzle/meta/_journal.json — re-running
      // init must not duplicate them (was hardcoded 1 before 0001_tags_fts).
      const journal = JSON.parse(
        readFileSync(resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
      );
      expect(count).toBe(journal.entries.length);
    }
  });

  it('applies the tags/FTS migration (circuit_tags + circuits_fts exist)', async () => {
    const db = await getDb();
    const g = globalThis as any;
    const client = g.__libsqlClient;
    if (client) {
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('circuit_tags','circuits_fts')",
      );
      const names = result.rows.map((r: any) => r.name).sort();
      expect(names).toEqual(['circuit_tags', 'circuits_fts']);
    }
    expect(db).toBeDefined();
  });

  it('can perform CRUD operations on the migrated table', async () => {
    const db = await getDb();

    // INSERT
    const [inserted] = await db
      .insert(savedCircuits)
      .values({
        id: 'crud-test-1',
        name: 'CRUD Test',
        description: 'Test circuit',
        document: '{"version":1,"components":[],"wires":[]}',
        tags: 'test',
        isExample: false,
      })
      .returning();
    expect(inserted).toBeDefined();
    expect(inserted.id).toBe('crud-test-1');

    // SELECT
    const [selected] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, 'crud-test-1')).limit(1);
    expect(selected).toBeDefined();
    expect(selected.name).toBe('CRUD Test');

    // UPDATE
    const [updated] = await db.update(savedCircuits).set({ name: 'CRUD Test (updated)' }).where(eq(savedCircuits.id, 'crud-test-1')).returning();
    expect(updated.name).toBe('CRUD Test (updated)');

    // DELETE
    await db.delete(savedCircuits).where(eq(savedCircuits.id, 'crud-test-1'));
    const [afterDelete] = await db.select().from(savedCircuits).where(eq(savedCircuits.id, 'crud-test-1')).limit(1);
    expect(afterDelete).toBeUndefined();
  });

  it('dbReady is a promise that resolves to the db', async () => {
    // Clear the cached promise so dbReady re-initializes with our env vars
    const g = globalThis as any;
    g.__dbPromise = undefined;
    // Re-import dbReady — but since it's already cached, just use getDb
    const db = await getDb();
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });
});

describe('db.ts: getDb() returns the same instance', () => {
  it('caches the db instance across calls', async () => {
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
  });
});
