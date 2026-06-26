// src/app/api/pitboss/cert/status/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const leagueId = req.nextUrl.searchParams.get('league_id')
  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  // ── Auth — same pattern as cert/start and cert/submit ─────────────────────
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = user.user_metadata?.provider_id ?? user.user_metadata?.sub ?? ''

  // ── Driver lookup ──────────────────────────────────────────────────────────
  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (!driver) {
    return NextResponse.json({
      status: null,
      locked_until: null,
      certification_id: null,
      is_commissioner: false,
    })
  }

  // ── Commissioner check ─────────────────────────────────────────────────────
  const { data: membership } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .maybeSingle()

  const isCommissioner = membership?.role === 'commissioner'

  // ── Latest certification attempt ───────────────────────────────────────────
  const { data: cert } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, status, locked_until, attempt_number')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!cert) {
    return NextResponse.json({
      status: null,
      locked_until: null,
      certification_id: null,
      is_commissioner: isCommissioner,
    })
  }

  // ── Commissioner lockout bypass ────────────────────────────────────────────
  if (isCommissioner && cert.status === 'failed' && cert.locked_until) {
    await supabase
      .schema('pitboss')
      .from('certifications')
      .update({ locked_until: null })
      .eq('id', cert.id)

    return NextResponse.json({
      status: null,
      locked_until: null,
      certification_id: null,
      is_commissioner: true,
    })
  }

  return NextResponse.json({
    status: cert.status,
    locked_until: cert.locked_until,
    certification_id: cert.id,
    is_commissioner: isCommissioner,
  })
}
