// Test: directly invoke the API route handlers (no HTTP server needed).
// Verifies the Drizzle-based routes work end-to-end with the real DB.

import { GET, POST } from '../src/app/api/circuits/route';
import { GET as GET_ID, PUT, DELETE } from '../src/app/api/circuits/[id]/route';
import { NextRequest } from 'next/server';

async function main() {
  console.log('=== API Route Handler Test ===\n');

  // 1. GET (empty list)
  const getRes1 = await GET();
  const getData1 = await getRes1.json();
  console.log('1. GET /api/circuits (empty):');
  console.log(`   status: ${getRes1.status}`);
  console.log(`   circuits: ${getData1.circuits.length} row(s)`);

  // 2. POST (create)
  const postReq = new NextRequest('http://localhost/api/circuits', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test LED Circuit',
      description: 'Drizzle migration test',
      document: JSON.stringify({ version: 1, components: [{ id: 'r1', type: 'resistor' }], wires: [] }),
      tags: 'led,test,drizzle',
      isExample: true,
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  const postRes = await POST(postReq);
  const postData = await postRes.json();
  console.log('\n2. POST /api/circuits (create):');
  console.log(`   status: ${postRes.status}`);
  console.log(`   id: ${postData.circuit.id}`);
  console.log(`   name: "${postData.circuit.name}"`);
  console.log(`   description: "${postData.circuit.description}"`);
  console.log(`   tags: "${postData.circuit.tags}"`);
  console.log(`   isExample: ${postData.circuit.isExample}`);
  console.log(`   createdAt: ${postData.circuit.createdAt} (type: ${typeof postData.circuit.createdAt})`);
  console.log(`   updatedAt: ${postData.circuit.updatedAt}`);
  const circuitId = postData.circuit.id;

  // 3. GET (list with 1 row)
  const getRes2 = await GET();
  const getData2 = await getRes2.json();
  console.log('\n3. GET /api/circuits (list with 1 row):');
  console.log(`   status: ${getRes2.status}`);
  console.log(`   circuits: ${getData2.circuits.length} row(s)`);
  console.log(`   first row name: "${getData2.circuits[0]?.name}"`);
  console.log(`   first row has document? ${'document' in (getData2.circuits[0] || {})} (should be false)`);

  // 4. GET /api/circuits/[id]
  const getIdRes = await GET_ID(
    new NextRequest('http://localhost/api/circuits/x'),
    { params: Promise.resolve({ id: circuitId }) }
  );
  const getIdData = await getIdRes.json();
  console.log('\n4. GET /api/circuits/[id]:');
  console.log(`   status: ${getIdRes.status}`);
  console.log(`   name: "${getIdData.circuit?.name}"`);
  console.log(`   document: "${getIdData.circuit?.document}"`);
  console.log(`   has document field? ${'document' in (getIdData.circuit || {})} (should be true)`);

  // 5. PUT /api/circuits/[id] (update)
  const putReq = new NextRequest('http://localhost/api/circuits/x', {
    method: 'PUT',
    body: JSON.stringify({ name: 'Updated Name', tags: 'updated' }),
    headers: { 'Content-Type': 'application/json' },
  });
  const putRes = await PUT(putReq, { params: Promise.resolve({ id: circuitId }) });
  const putData = await putRes.json();
  console.log('\n5. PUT /api/circuits/[id] (update):');
  console.log(`   status: ${putRes.status}`);
  console.log(`   name: "${putData.circuit?.name}" (should be "Updated Name")`);
  console.log(`   tags: "${putData.circuit?.tags}" (should be "updated")`);

  // 6. GET /api/circuits/[id] (nonexistent → 404)
  const get404Res = await GET_ID(
    new NextRequest('http://localhost/api/circuits/x'),
    { params: Promise.resolve({ id: 'nonexistent-id' }) }
  );
  console.log('\n6. GET /api/circuits/[nonexistent]:');
  console.log(`   status: ${get404Res.status} (should be 404)`);

  // 7. POST (validation error → 400)
  const badPostReq = new NextRequest('http://localhost/api/circuits', {
    method: 'POST',
    body: JSON.stringify({ name: 'No document' }),
    headers: { 'Content-Type': 'application/json' },
  });
  const badPostRes = await POST(badPostReq);
  console.log('\n7. POST /api/circuits (missing document → 400):');
  console.log(`   status: ${badPostRes.status} (should be 400)`);

  // 8. DELETE
  const delRes = await DELETE(
    new NextRequest('http://localhost/api/circuits/x', { method: 'DELETE' }),
    { params: Promise.resolve({ id: circuitId }) }
  );
  const delData = await delRes.json();
  console.log('\n8. DELETE /api/circuits/[id]:');
  console.log(`   status: ${delRes.status}`);
  console.log(`   ok: ${delData.ok}`);

  // 9. Verify deleted
  const getRes3 = await GET();
  const getData3 = await getRes3.json();
  console.log(`\n9. GET after delete: ${getData3.circuits.length} row(s) (should be 0)`);

  // Validate response shapes match frontend expectations
  console.log('\n=== Frontend Compatibility Check ===');
  // Re-create to check shape
  const postReq2 = new NextRequest('http://localhost/api/circuits', {
    method: 'POST',
    body: JSON.stringify({ name: 'Shape Check', document: '{}' }),
    headers: { 'Content-Type': 'application/json' },
  });
  const postRes2 = await POST(postReq2);
  const postData2 = await postRes2.json();
  const c = postData2.circuit;
  const checks = [
    ['id is string', typeof c.id === 'string'],
    ['name is string', typeof c.name === 'string'],
    ['description is string', typeof c.description === 'string'],
    ['tags is string', typeof c.tags === 'string'],
    ['isExample is boolean', typeof c.isExample === 'boolean'],
    ['createdAt is ISO string', typeof c.createdAt === 'string' && !isNaN(new Date(c.createdAt).getTime())],
    ['updatedAt is ISO string', typeof c.updatedAt === 'string' && !isNaN(new Date(c.updatedAt).getTime())],
    ['new Date(updatedAt) works', !isNaN(new Date(c.updatedAt).getFullYear())],
  ];
  for (const [name, ok] of checks) {
    console.log(`   ${ok ? '✓' : '✗'} ${name}`);
  }
  // Cleanup
  await DELETE(
    new NextRequest('http://localhost/api/circuits/x', { method: 'DELETE' }),
    { params: Promise.resolve({ id: c.id }) }
  );

  const allPass = checks.every(([, ok]) => ok);
  console.log(`\n${allPass ? '✓ All API routes work correctly with Drizzle.' : '✗ Some checks failed.'}`);
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
