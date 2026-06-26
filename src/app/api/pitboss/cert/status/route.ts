import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const CERT_WINDOW_MS = 60 * 60 * 1000

// ─── GET /api/pitboss/cert/status ─────────────────────────────────────────────
// Single SQL call instead of 3–4 sequential round-trips.
// Returns driver + latest cert + licence in one query.
export async function GET(req: NextRequest) {
 const supabase = await createClient()
 const { searchParams } = new URL(req.url)

 const league_id = searchParams.get('league_id')
 if (!league_id) {
   return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
 }

 // ── Auth ──────────────────────────────────────────────────────────────────
 const { data: { user }, error: authError } = await supabase.auth.getUser()
 if (authError || !user) {
   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 }

 const discordId = user.user_metadata?.provider_id ?? user.user_metadata?.sub ?? ''

 // ── Single collapsed query: driver + cert + licence ───────────────────────
 const { data, error } = await supabase.rpc('get_cert_status', {
   p_discord_id: discordId,
   p_league_id:  league_id,
 })

 if (error) {
   // RPC not yet deployed — fall back to sequential queries
   return fallback(supabase, discordId, league_id)
 }

 if (!data || data.length === 0) {
   return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
 }

 return buildResponse(data[0])
}

// ── Build response from collapsed row ─────────────────────────────────────────
function buildResponse(row: {
 driver_id:         string
 cert_id:           string | null
 cert_status:       string | null
 score:             number | null
 pass_mark:         number | null
 started_at:        string | null
 completed_at:      string | null
 locked_until:      string | null
 attempt_number:    number | null
 token:             string | null
 licence_id:        string | null
 licence_number:    string | null
 licence_status:    string | null
 licence_issued_at: string | null
}) {
 const now = new Date()

 if (!row.cert_id) {
   return NextResponse.json({ status: 'eligible', attempt_number: 0 })
 }

 let effectiveStatus = row.cert_status ?? 'eligible'

 if (
   row.cert_status === 'in_progress' &&
   row.started_at &&
   now.getTime() - new Date(row.started_at).getTime() > CERT_WINDOW_MS
 ) {
   effectiveStatus = 'timed_out'
 }

 if (
   row.cert_status === 'failed' &&
   row.locked_until &&
   new Date(row.locked_until) <= now
 ) {
   effectiveStatus = 'eligible'
 }

 const licence = row.licence_id
   ? {
       id:             row.licence_id,
       licence_number: row.licence_number,
       status:         row.licence_status,
       issued_at:      row.licence_issued_at,
     }
   : null

 return NextResponse.json({
   status:           effectiveStatus,
   certification_id: row.cert_id,
   score:            row.score,
   pass_mark:        row.pass_mark,
   started_at:       row.started_at,
   completed_at:     row.completed_at,
   locked_until:     row.locked_until,
   attempt_number:   row.attempt_number,
   token:            row.cert_status === 'passed' ? row.token : null,
   licence,
 })
}

// ── Fallback: sequential queries (used until RPC is deployed) ─────────────────
async function fallback(
 supabase: Awaited<ReturnType<typeof createClient>>,
 discordId: string,
 league_id: string
) {
 const { data: driver } = await supabase
   .schema('pitboss')
   .from('drivers')
   .select('id')
   .eq('discord_id', discordId)
   .maybeSingle()

 if (!driver) {
   return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
 }

 const { data: cert } = await supabase
   .schema('pitboss')
   .from('certifications')
   .select('id, status, score, pass_mark, started_at, completed_at, locked_until, attempt_number, token')
   .eq('driver_id', driver.id)
   .eq('league_id', league_id)
   .order('created_at', { ascending: false })
   .limit(1)
   .maybeSingle()

 if (!cert) {
   return NextResponse.json({ status: 'eligible', attempt_number: 0 })
 }

 const now = new Date()
 let effectiveStatus = cert.status

 if (
   cert.status === 'in_progress' &&
   cert.started_at &&
   now.getTime() - new Date(cert.started_at).getTime() > CERT_WINDOW_MS
 ) {
   effectiveStatus = 'timed_out'
 }

 if (
   cert.status === 'failed' &&
   cert.locked_until &&
   new Date(cert.locked_until) <= now
 ) {
   effectiveStatus = 'eligible'
 }

 let licence = null
 if (cert.status === 'passed') {
   const { data: licenceData } = await supabase
     .schema('pitboss')
     .from('licences')
     .select('id, licence_number, status, issued_at')
     .eq('driver_id', driver.id)
     .eq('league_id', league_id)
     .eq('role_code', 'driver')
     .eq('status', 'active')
     .maybeSingle()
   licence = licenceData
 }

 return NextResponse.json({
   status:           effectiveStatus,
   certification_id: cert.id,
   score:            cert.score,
   pass_mark:        cert.pass_mark,
   started_at:       cert.started_at,
   completed_at:     cert.completed_at,
   locked_until:     cert.locked_until,
   attempt_number:   cert.attempt_number,
   token:            cert.status === 'passed' ? cert.token : null,
   licence,
 })
}
