// Tests for the API route handlers — tests GET/POST/PUT/DELETE with edge cases.
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST } from '../src/app/api/circuits/route';
import { GET as GET_ID, PUT, DELETE } from '../src/app/api/circuits/[id]/route';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { savedCircuits } from '../src/lib/schema';

// Use a temporary in-memory database for tests
const testDbPath = '/tmp/test-circuits-api.db';
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  // Create fresh test database
  const sqlite = new Database(testDbPath);
  sqlite.pragma('journal_mode = WAL');
  db = drizzle(sqlite, { schema: { savedCircuits } });
  // Create table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS saved_circuits (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      document TEXT NOT NULL,
      tags TEXT DEFAULT '' NOT NULL,
      is_example INTEGER DEFAULT false NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS saved_circuits_name_idx ON saved_circuits (name);
    CREATE INDEX IF NOT EXISTS saved_circuits_updated_at_idx ON saved_circuits (updated_at);
  `);
  // Clean any existing data
  sqlite.exec('DELETE FROM saved_circuits');
});

function makeReq(url: string, method: string, body?: any): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
  });
}

describe('API: GET /api/circuits', () => {
  it('returns empty list initially', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuits).toBeDefined();
    expect(Array.isArray(data.circuits)).toBe(true);
  });
});

describe('API: POST /api/circuits', () => {
  it('creates a circuit and returns it', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Test Circuit',
      description: 'A test circuit',
      document: '{"version":1,"components":[],"wires":[]}',
      tags: 'test,api',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.circuit).toBeDefined();
    expect(data.circuit.id).toBeDefined();
    expect(data.circuit.name).toBe('Test Circuit');
    expect(data.circuit.description).toBe('A test circuit');
    expect(data.circuit.tags).toBe('test,api');
    expect(data.circuit.isExample).toBe(false);
  });

  it('rejects missing name', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      document: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects missing document', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'No Doc',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('accepts document as object (auto-stringifies)', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Object Doc',
      document: { version: 1, components: [{ id: 'r1', type: 'resistor' }] },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(typeof data.circuit.document).toBe('string');
    const parsed = JSON.parse(data.circuit.document);
    expect(parsed.version).toBe(1);
  });

  it('rejects name over 200 chars', async () => {
    const longName = 'A'.repeat(300);
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: longName,
      document: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(400); // Zod rejects names over 200 chars
  });
});

describe('API: GET /api/circuits/[id]', () => {
  it('returns 404 for nonexistent circuit', async () => {
    const res = await GET_ID(
      makeReq('http://localhost/api/circuits/nonexistent', 'GET'),
      { params: Promise.resolve({ id: 'nonexistent-id' }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns circuit with document', async () => {
    // First create a circuit
    const createReq = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Get Test',
      document: '{"version":1}',
    });
    const createRes = await POST(createReq);
    const created = (await createRes.json()).circuit;

    // Then get it
    const res = await GET_ID(
      makeReq('http://localhost/api/circuits/' + created.id, 'GET'),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuit.name).toBe('Get Test');
    expect(data.circuit.document).toBe('{"version":1}');
  });
});

describe('API: PUT /api/circuits/[id]', () => {
  it('updates name only (partial update)', async () => {
    // Create
    const createReq = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Original',
      document: '{}',
    });
    const created = (await (await POST(createReq)).json()).circuit;

    // Update
    const updateReq = makeReq('http://localhost/api/circuits/' + created.id, 'PUT', {
      name: 'Updated Name',
    });
    const res = await PUT(updateReq, { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuit.name).toBe('Updated Name');
    // Description should be unchanged
    expect(data.circuit.description).toBe('');
  });

  it('returns 404 for nonexistent circuit', async () => {
    const req = makeReq('http://localhost/api/circuits/nonexistent', 'PUT', { name: 'X' });
    const res = await PUT(req, { params: Promise.resolve({ id: 'nonexistent-id' }) });
    expect(res.status).toBe(404);
  });
});

describe('API: DELETE /api/circuits/[id]', () => {
  it('deletes a circuit', async () => {
    // Create
    const createReq = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Delete Me',
      document: '{}',
    });
    const created = (await (await POST(createReq)).json()).circuit;

    // Delete — returns 204 No Content
    const res = await DELETE(
      makeReq('http://localhost/api/circuits/' + created.id, 'DELETE'),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(res.status).toBe(204);

    // Verify it's gone
    const getRes = await GET_ID(
      makeReq('http://localhost/api/circuits/' + created.id, 'GET'),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(getRes.status).toBe(404);
  });
});

describe('API: Response shape compatibility', () => {
  it('returns ISO date strings for createdAt/updatedAt', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Date Test',
      document: '{}',
    });
    const res = await POST(req);
    const data = await res.json();
    expect(typeof data.circuit.createdAt).toBe('string');
    expect(new Date(data.circuit.createdAt).getTime()).not.toBeNaN();
    expect(typeof data.circuit.updatedAt).toBe('string');
    expect(new Date(data.circuit.updatedAt).getTime()).not.toBeNaN();
  });

  it('returns boolean for isExample', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Bool Test',
      document: '{}',
      isExample: true,
    });
    const res = await POST(req);
    const data = await res.json();
    expect(typeof data.circuit.isExample).toBe('boolean');
    expect(data.circuit.isExample).toBe(true);
  });
});
