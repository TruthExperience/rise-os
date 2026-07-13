import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function GET() {
  const [carClassesRes, tracksRes] = await Promise.all([
    supabaseAdmin
      .schema('pitboss')
      .from('car_classes')
      .select('id, code, display_name, category, season')
      .order('category')
      .order('season'),
    supabaseAdmin
      .schema('pitboss')
      .from('tracks')
      .select('id, slug, name, country, archetype')
      .order('name'),
  ]);

  if (carClassesRes.error) {
    return NextResponse.json({ error: `Failed to load car classes: ${carClassesRes.error.message}` }, { status: 500 });
  }
  if (tracksRes.error) {
    return NextResponse.json({ error: `Failed to load tracks: ${tracksRes.error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    car_classes: carClassesRes.data ?? [],
    tracks:       tracksRes.data ?? [],
  });
}
