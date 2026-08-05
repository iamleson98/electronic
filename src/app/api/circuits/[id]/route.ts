import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { savedCircuits } from '@/lib/schema';
import { updateCircuitSchema } from '@/lib/validation-schemas';

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/circuits/[id] — fetch one circuit (including its `document`).
export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const [circuit] = await db
      .select()
      .from(savedCircuits)
      .where(eq(savedCircuits.id, id))
      .limit(1);

    if (!circuit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ circuit });
  } catch (err) {
    console.error('[API] GET /api/circuits/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/circuits/[id] — update an existing circuit.
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

    const [circuit] = await db
      .update(savedCircuits)
      .set(updates as Record<string, unknown>)
      .where(eq(savedCircuits.id, id))
      .returning();

    if (!circuit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ circuit });
  } catch (err) {
    console.error('[API] PUT /api/circuits/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/circuits/[id]
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    await db.delete(savedCircuits).where(eq(savedCircuits.id, id));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[API] DELETE /api/circuits/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
