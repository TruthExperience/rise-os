import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';

export const dynamic = 'force-dynamic';

// DELETE: un-save a setup. The recommendation row stays (feedback and
// adjustment history reference it); it just leaves the saved list.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema('pitboss')
    .from('setup_recommendations')
    .update({ saved_at: null, label: null })
    .eq('id', id)
    .eq('driver_id', driver.id)
    .select('id')
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Saved setup not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
