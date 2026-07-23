import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/circuits/[id] - get one circuit (with document)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const circuit = await db.savedCircuit.findUnique({ where: { id } });
    if (!circuit) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ circuit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PUT /api/circuits/[id] - update circuit
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, description, document, tags, isExample } = body;
    const circuit = await db.savedCircuit.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: String(name).slice(0, 200) } : {}),
        ...(description !== undefined ? { description: String(description).slice(0, 1000) } : {}),
        ...(document !== undefined ? { document: typeof document === 'string' ? document : JSON.stringify(document) } : {}),
        ...(tags !== undefined ? { tags: String(tags).slice(0, 500) } : {}),
        ...(isExample !== undefined ? { isExample: !!isExample } : {}),
      },
    });
    return NextResponse.json({ circuit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// DELETE /api/circuits/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.savedCircuit.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
