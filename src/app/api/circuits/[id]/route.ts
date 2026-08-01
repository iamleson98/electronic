import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { savedCircuits } from '@/lib/schema';
import { toUpdateValues } from '@/lib/circuit-input';

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
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PUT /api/circuits/[id] — update an existing circuit.
// Only the provided fields are touched (partial update).
export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await req.json();

    const [circuit] = await db
      .update(savedCircuits)
      .set(toUpdateValues(body ?? {}))
      .where(eq(savedCircuits.id, id))
      .returning();

    if (!circuit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ circuit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// DELETE /api/circuits/[id]
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    await db.delete(savedCircuits).where(eq(savedCircuits.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
