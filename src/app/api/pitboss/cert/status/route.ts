// src/app/api/pitboss/cert/status/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = (session.user as any).discordId
  if (!discordId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

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

  const { data: membership } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .maybeSingle()

  const isCommissioner = membership?.role === 'commissioner'

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
