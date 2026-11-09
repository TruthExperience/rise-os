import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Read-only progress history for one career driver: one snapshot per saved
// stat update, oldest first (latest 100 only).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema('pitboss')
    .from('career_driver_stat_history')
    .select('id, pace, racecraft, awareness, experience, focus, overall, recorded_at')
    .eq('career_driver_id', id)
    .order('recorded_at', { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ history: (data ?? []).reverse() });
}
