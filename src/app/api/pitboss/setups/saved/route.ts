import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';

export const dynamic = 'force-dynamic';

const MAX_LABEL_LENGTH = 80;
const SAVED_LIMIT = 100;

const REC_COLUMNS =
  'id, car_class_id, track_id, conditions, session_type, generated_setup, rationale, confidence, baseline_used, model, created_at, saved_at, label, car_team_id, career_driver_id';

// GET: the signed-in driver's saved setups, newest first, with track and
// car class names so the list can be shown without extra lookups.
export async function GET() {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema('pitboss')
    .from('setup_recommendations')
    .select(REC_COLUMNS)
    .eq('driver_id', driver.id)
    .not('saved_at', 'is', null)
    .order('saved_at', { ascending: false })
    .limit(SAVED_LIMIT);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = data ?? [];

  const trackIds = Array.from(new Set(rows.map((r: any) => r.track_id)));
  const classIds = Array.from(new Set(rows.map((r: any) => r.car_class_id)));
  const [tracksRes, classesRes] = await Promise.all([
    trackIds.length
      ? admin.schema('pitboss').from('tracks').select('id, name').in('id', trackIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    classIds.length
      ? admin.schema('pitboss').from('car_classes').select('id, display_name').in('id', classIds)
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);
  const trackName = new Map((tracksRes.data ?? []).map((t: any) => [t.id, t.name]));
  const className = new Map((classesRes.data ?? []).map((c: any) => [c.id, c.display_name]));

  return NextResponse.json({
    saved: rows.map((r: any) => ({
      ...r,
      track_name: trackName.get(r.track_id) ?? null,
      car_class_name: className.get(r.car_class_id) ?? null,
    })),
  });
}

// POST: save one of the signed-in driver's own recommendations.
// Body: { recommendation_id: string, label?: string | null }
export async function POST(req: NextRequest) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { recommendation_id?: string; label?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body.recommendation_id !== 'string' || !body.recommendation_id) {
    return NextResponse.json({ error: 'recommendation_id is required' }, { status: 400 });
  }
  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string' || body.label.trim().length > MAX_LABEL_LENGTH) {
      return NextResponse.json(
        { error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }
    label = body.label.trim() || null;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema('pitboss')
    .from('setup_recommendations')
    .update({ saved_at: new Date().toISOString(), label })
    .eq('id', body.recommendation_id)
    .eq('driver_id', driver.id)
    .select(REC_COLUMNS)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Recommendation not found' }, { status: 404 });
  }
  return NextResponse.json(data);
}
