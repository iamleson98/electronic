import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { savedCircuits } from '@/lib/schema';
import { deleteCircuit, updateCircuit, withTagList } from '@/lib/circuits-service';
import { updateCircuitSchema } from '@/lib/validation-schemas';

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/circuits/[id] — fetch one circuit (including its `document`).
export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const db = await getDb();
    const [circuit] = await db
      .select()
      .from(savedCircuits)
      .where(eq(savedCircuits.id, id))
      .limit(1);

    if (!circuit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    // `tagList` is an added field; all pre-existing fields are unchanged.
    return NextResponse.json({ circuit: withTagList(circuit) });
  } catch (err) {
    console.error('[API] GET /api/circuits/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/circuits/[id] — update an existing circuit.
// The TEXT `tags` column, the normalized `circuit_tags` rows and the
// `circuits_fts` index entry are re-synced atomically (one libsql write batch)
// whenever the circuit is updated — name/description changes re-index FTS too.
export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;

    const contentType = req.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = updateCircuitSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parseResult.error.flatten() },
        { status: 400 },
      );
    }

    const updates = parseResult.data;

    const circuit = await updateCircuit(await getDb(), id, {
      name: updates.name,
      description: updates.description,
      document: updates.document,
      tags: updates.tags,
      isExample: updates.isExample,
    });

    if (!circuit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ circuit: withTagList(circuit) });
  } catch (err) {
    console.error('[API] PUT /api/circuits/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/circuits/[id]
// Removes the saved_circuits row together with its circuit_tags and
// circuits_fts entries in one atomic batch.
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    await deleteCircuit(await getDb(), id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[API] DELETE /api/circuits/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
