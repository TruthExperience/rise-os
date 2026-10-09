import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 80;
const MAX_NOTES_LENGTH = 1000;

// Pace weighted heaviest, mirroring EA's F1 25 Driver Career overall calc.
// Kept identical to the weighting in the parent GET/POST route — duplicated
// here rather than shared to avoid introducing a new lib import for one
// small function; revisit if this route family grows further.
function computeOverall(
  pace: number,
  racecraft: number,
  awareness: number,
  experience: number,
  focus: number
): number {
  const weighted =
    pace * 0.35 + racecraft * 0.2 + awareness * 0.2 + experience * 0.15 + focus * 0.1;
  return Math.round(weighted);
}

interface PatchBody {
  pace?: number;
  racecraft?: number;
  awareness?: number;
  experience?: number;
  focus?: number;
  driver_name?: string;
  notes?: string | null;
}

// career_mode_drivers is a shared library: every recommendation that picks a
// career driver reads these ratings. It has no owner column, so there is no
// "creator" to check. Editing existing entries is therefore limited to
// commissioners, owners and co-owners (any league). Nothing in the app calls
// this route today, so no page changes.
async function isAdminInAnyLeague(driverId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema('pitboss')
    .from('driver_leagues')
    .select('is_commissioner, is_owner, is_co_owner')
    .eq('driver_id', driverId);
  if (error || !data?.length) return false;
  return data.some((r: any) => Boolean(r.is_commissioner || r.is_owner || r.is_co_owner));
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isAdminInAnyLeague(driver.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabaseAdmin = createAdminClient();
  const { id } = await params;
  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .schema('pitboss')
    .from('career_mode_drivers')
    .select('id, pace, racecraft, awareness, experience, focus')
    .eq('id', id)
    .single();
  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Career driver not found' }, { status: 404 });
  }
  const statFields = ['pace', 'racecraft', 'awareness', 'experience', 'focus'] as const;
  for (const field of statFields) {
    const val = body[field];
    if (
      val !== undefined &&
      (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 99)
    ) {
      return NextResponse.json({ error: `${field} must be a number between 0 and 99` }, { status: 400 });
    }
  }
  const merged = {
    pace: body.pace ?? existing.pace,
    racecraft: body.racecraft ?? existing.racecraft,
    awareness: body.awareness ?? existing.awareness,
    experience: body.experience ?? existing.experience,
    focus: body.focus ?? existing.focus,
  };
  const updatePayload: Record<string, unknown> = {
    ...merged,
    overall: computeOverall(merged.pace, merged.racecraft, merged.awareness, merged.experience, merged.focus),
  };
  if (body.driver_name !== undefined) {
    if (typeof body.driver_name !== 'string' || !body.driver_name.trim()) {
      return NextResponse.json({ error: 'driver_name cannot be empty' }, { status: 400 });
    }
    if (body.driver_name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `driver_name must be ${MAX_NAME_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }
    updatePayload.driver_name = body.driver_name.trim();
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_LENGTH)) {
      return NextResponse.json(
        { error: `notes must be a string of ${MAX_NOTES_LENGTH} characters or fewer, or null` },
        { status: 400 }
      );
    }
    updatePayload.notes = body.notes;
  }
  const { data, error } = await supabaseAdmin
    .schema('pitboss')
    .from('career_mode_drivers')
    .update(updatePayload)
    .eq('id', id)
    .select('id, driver_name, pace, racecraft, awareness, experience, focus, overall, notes, updated_at')
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to update career driver' }, { status: 500 });
  }
  return NextResponse.json(data);
}
