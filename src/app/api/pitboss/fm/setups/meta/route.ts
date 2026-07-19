import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = createAdminClient()

  const [{ data: tracks, error: tracksError }, { data: params, error: paramsError }] =
    await Promise.all([
      supabase
        .schema('pitboss')
        .from('fm_circuits')
        .select('id, name, slug, country')
        .order('round_order', { ascending: true }),
      supabase
        .schema('pitboss')
        .from('fm_setup_params')
        .select('param_key, label, characteristic, min_value, max_value, step, unit, value_format, display_order')
        .order('display_order', { ascending: true }),
    ])

  if (tracksError) {
    return NextResponse.json({ error: tracksError.message }, { status: 500 })
  }
  if (paramsError) {
    return NextResponse.json({ error: paramsError.message }, { status: 500 })
  }

  return NextResponse.json({
    tracks: tracks ?? [],
    params: (params ?? []).map((p) => ({
      ...p,
      min_value: Number(p.min_value),
      max_value: Number(p.max_value),
      step: Number(p.step),
    })),
  })
}
