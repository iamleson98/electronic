import { NextRequest, NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { savedCircuits } from '@/lib/schema';
import { toCreateValues } from '@/lib/circuit-input';

// GET /api/circuits — list all saved circuits (without the heavy `document` column).
export async function GET() {
  try {
    const circuits = await db
      .select({
        id: savedCircuits.id,
        name: savedCircuits.name,
        description: savedCircuits.description,
        tags: savedCircuits.tags,
        isExample: savedCircuits.isExample,
        createdAt: savedCircuits.createdAt,
        updatedAt: savedCircuits.updatedAt,
      })
      .from(savedCircuits)
      .orderBy(desc(savedCircuits.updatedAt));
    return NextResponse.json({ circuits });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/circuits — create a new saved circuit.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body?.name || !body?.document) {
      return NextResponse.json({ error: 'name and document are required' }, { status: 400 });
    }

    const [circuit] = await db
      .insert(savedCircuits)
      .values(toCreateValues(body))
      .returning();

    return NextResponse.json({ circuit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
