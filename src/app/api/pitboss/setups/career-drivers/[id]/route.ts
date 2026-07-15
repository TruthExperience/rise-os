import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

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

// No ownership/session check — career_mode_drivers is a searchable library
// with no account tie (driver_id is nullable and unrelated to auth), same
// model as car_driver_id selection elsewhere in the setup engine. Any
// authenticated setup-engine caller can adjust ratings, matching how the
// GET/POST routes on the parent are also unauthenticated.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
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
    if (val !== undefined && (typeof val !== 'number' || val < 0 || val > 99)) {
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
    if (!body.driver_name.trim()) {
      return NextResponse.json({ error: 'driver_name cannot be empty' }, { status: 400 });
    }
    updatePayload.driver_name = body.driver_name.trim();
  }

  if (body.notes !== undefined) {
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
