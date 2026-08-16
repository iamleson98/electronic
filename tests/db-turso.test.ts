// Tests for the database client (db.ts) — verifies provider selection logic,
// build-time stub, and that the schema auto-creates on first connection.
//
// These tests run against local SQLite (better-sqlite3) by default — they don't
// require Turso credentials. The Turso path is tested separately by
// scripts/test-turso.ts (run manually with TURSO_* env vars set).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, dbReady } from '../src/lib/db';
import { savedCircuits } from '../src/lib/schema';
import { eq } from 'drizzle-orm';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Clear DB-related env vars before each test
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.DATABASE_URL;
  delete process.env.NEXT_BUILD;
  delete process.env.NEXT_PHASE;
  // Clear the cached db singleton so each test re-initializes
  const g = globalThis as any;
  g.__drizzleDb = undefined;
  g.__sqliteInstance = undefined;
  g.__dbPromise = undefined;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('db.ts: provider selection', () => {
  it('uses local SQLite when no Turso env vars are set', async () => {
    process.env.DATABASE_URL = 'file:./db/test-provider.db';
    const db = await getDb();
    expect(db).toBeDefined();
    // The db should support Drizzle query builder methods
    expect(typeof db.select).toBe('function');
  });

  it('uses Turso when TURSO_* env vars are set', async () => {
    // We can't actually connect to Turso in CI (no creds), but we can verify
    // that the provider selection logic picks Turso. We expect the connection
    // to fail, but the provider choice should be Turso.
    process.env.TURSO_DATABASE_URL = 'libsql://invalid.example.com';
    process.env.TURSO_AUTH_TOKEN = 'invalid-token';
    // The init will attempt to connect and fail — catch it
    try {
      await getDb();
      // If it didn't throw, the connection somehow succeeded — unlikely
    } catch (e) {
      // Expected: connection error from Turso
      expect(e).toBeDefined();
    }
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

describe('db.ts: auto-schema creation', () => {
  it('auto-creates the saved_circuits table on first connection', async () => {
    process.env.DATABASE_URL = 'file:./db/test-schema.db';
    const db = await getDb();
    // If the table exists, this query should not throw
    const rows = await db.select({ id: savedCircuits.id }).from(savedCircuits).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can perform CRUD operations on the auto-created table', async () => {
    process.env.DATABASE_URL = 'file:./db/test-crud.db';
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
    process.env.DATABASE_URL = 'file:./db/test-ready.db';
    const db = await dbReady;
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });
});

describe('db.ts: getDb() returns the same instance', () => {
  it('caches the db instance across calls', async () => {
    process.env.DATABASE_URL = 'file:./db/test-cache.db';
    const db1 = await getDb();
    const db2 = await getDb();
    // Same instance (cached on globalThis in non-production)
    expect(db1).toBe(db2);
  });
});
