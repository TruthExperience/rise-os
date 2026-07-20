import { NextRequest, NextResponse } from 'next/server';
import { fetchParamRanges } from '@/lib/pitboss/setup-engine-data';

// Forces this route to opt out of Next.js's static/Data Cache handling —
// same rationale as the recommend route: param ranges change via direct
// SQL/migrations, not revalidation, so a cached GET here can serve stale
// data indefinitely across deployments.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const carClassId = req.nextUrl.searchParams.get('car_class_id');
  const sessionType = req.nextUrl.searchParams.get('session_type');

  if (!carClassId || !sessionType) {
    return NextResponse.json({ error: 'car_class_id and session_type are required' }, { status: 400 });
  }

  try {
    const params = await fetchParamRanges(carClassId, sessionType);
    return NextResponse.json({ params });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load param ranges' },
      { status: 500 }
    );
  }
}
