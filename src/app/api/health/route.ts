// GET /api/health — health check endpoint for load balancers / monitoring.
// Returns 200 if the server and database are operational.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { savedCircuits } from '@/lib/schema';
import { sql } from 'drizzle-orm';

export async function GET() {
  try {
    // Quick DB ping — SELECT 1
    await db.select({ one: sql`1` }).from(savedCircuits).limit(1);
    return NextResponse.json({
      status: 'ok',
      database: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Health] Database check failed:', err);
    return NextResponse.json(
      {
        status: 'error',
        database: 'error',
        error: 'Database connection failed',
      },
      { status: 503 },
    );
  }
}
