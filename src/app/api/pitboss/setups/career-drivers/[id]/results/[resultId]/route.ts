import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';

export const dynamic = 'force-dynamic';

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

// A logged result can be deleted by whoever logged it, or by an admin.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; resultId: string }> }
) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id, resultId } = await params;
  const admin = createAdminClient();

  const { data: row, error: fetchError } = await admin
    .schema('pitboss')
    .from('career_driver_race_results')
    .select('id, recorded_by')
    .eq('id', resultId)
    .eq('career_driver_id', id)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: 'Result not found' }, { status: 404 });
  }
  if (row.recorded_by !== driver.id && !(await isAdminInAnyLeague(driver.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await admin
    .schema('pitboss')
    .from('career_driver_race_results')
    .delete()
    .eq('id', resultId)
    .eq('career_driver_id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ deleted: true });
}
