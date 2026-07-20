import { NextRequest, NextResponse } from 'next/server';
import { fetchParamRanges } from '@/lib/pitboss/setup-engine-data';

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
