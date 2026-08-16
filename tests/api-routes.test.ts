// Tests for the API route handlers — tests GET/POST/PUT/DELETE with edge cases.
// Uses @libsql/client with an in-memory database and mocks getDb() so the
// API routes use the test DB instead of the real Turso connection.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock must be before imports of the route handlers
const { createClient } = await import('@libsql/client');
const { drizzle } = await import('drizzle-orm/libsql');
const { savedCircuits } = await import('../src/lib/schema');

// Create a test DB in memory — stored in a module-level variable so the
// mock factory can reference it.
const client = createClient({ url: ':memory:' });
const testDb = drizzle(client, { schema: { savedCircuits } });

vi.mock('@/lib/db', () => ({
  getDb: async () => testDb,
  dbReady: Promise.resolve(testDb),
}));

const { GET, POST } = await import('../src/app/api/circuits/route');
const { GET: GET_ID, PUT, DELETE } = await import('../src/app/api/circuits/[id]/route');

beforeAll(async () => {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS saved_circuits (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      document TEXT NOT NULL,
      tags TEXT DEFAULT '' NOT NULL,
      is_example INTEGER DEFAULT false NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    )
  `);
  await client.execute('CREATE INDEX IF NOT EXISTS saved_circuits_name_idx ON saved_circuits (name)');
  await client.execute('CREATE INDEX IF NOT EXISTS saved_circuits_updated_at_idx ON saved_circuits (updated_at)');
  await client.execute('DELETE FROM saved_circuits');
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
      tags: 'test',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.circuit).toBeDefined();
    expect(data.circuit.name).toBe('Test Circuit');
    expect(data.circuit.id).toBeDefined();
  });

  it('accepts document as object (auto-stringifies)', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      name: 'Object Doc',
      document: { version: 1, components: [{ id: 'R1', type: 'resistor' }] },
      tags: '',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('rejects missing name', async () => {
    const req = makeReq('http://localhost/api/circuits', 'POST', {
      document: '{}',
      tags: '',
      isExample: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/circuits', {
      method: 'POST',
      body: 'invalid json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('API: GET /api/circuits/[id]', () => {
  it('fetches a circuit by id', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Fetch Me',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: inserted.id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuit.name).toBe('Fetch Me');
  });

  it('returns 404 for nonexistent id', async () => {
    const req = makeReq('http://localhost/api/circuits/nonexistent', 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });
});

describe('API: PUT /api/circuits/[id]', () => {
  it('updates a circuit', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Before Update',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'PUT', {
      name: 'After Update',
      tags: 'updated',
    });
    const res = await PUT(req, { params: Promise.resolve({ id: inserted.id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.circuit.name).toBe('After Update');
    expect(data.circuit.tags).toBe('updated');
  });

  it('returns 404 for nonexistent id', async () => {
    const req = makeReq('http://localhost/api/circuits/nonexistent', 'PUT', {
      name: 'Nope',
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });
});

describe('API: DELETE /api/circuits/[id]', () => {
  it('deletes a circuit', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Delete Me',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'DELETE');
    const res = await DELETE(req, { params: Promise.resolve({ id: inserted.id }) });
    expect(res.status).toBe(204);
  });
});

describe('API: Response shape compatibility', () => {
  it('returns circuit with id, name, description fields', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Shape Test',
      description: 'desc',
      document: '{}',
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: inserted.id }) });
    const data = await res.json();
    expect(data.circuit.id).toBeDefined();
    expect(data.circuit.name).toBe('Shape Test');
    expect(data.circuit.description).toBe('desc');
    expect(typeof data.circuit.createdAt).toMatch(/^(object|string|number)$/); // Date, string, or number
  });

  it('returns boolean for isExample', async () => {
    const [inserted] = await testDb.insert(savedCircuits).values({
      name: 'Example Circuit',
      document: '{}',
      isExample: true,
    }).returning();
    const req = makeReq(`http://localhost/api/circuits/${inserted.id}`, 'GET');
    const res = await GET_ID(req, { params: Promise.resolve({ id: inserted.id }) });
    const data = await res.json();
    expect(typeof data.circuit.isExample).toBe('boolean');
    expect(data.circuit.isExample).toBe(true);
  });
});
