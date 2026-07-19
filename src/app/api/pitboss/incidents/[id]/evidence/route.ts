import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'
import { getRequestingDriver, hasStewwardAccess } from '@/lib/pitboss/stewardAccess'

interface EvidencePostBody {
  party: 'reporter' | 'accused'
  source: 'upload' | 'link'
  url: string
  label?: string | null
}

interface EvidenceRow {
  id: string
  party: 'reporter' | 'accused'
  source: 'upload' | 'link'
  url: string
  label: string | null
  added_by: string
  added_by_role: 'reporter' | 'accused' | 'steward'
  created_at: string | null
  legacy?: boolean
}

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 72 // 72 hours

// Resolves 'upload' rows (which store a raw storage path, since the bucket
// is private) into a short-lived signed URL for display. 'link' rows
// (external URLs, including the folded-in legacy ones) pass through
// unchanged — they were never in Storage to begin with.
async function resolveEvidenceUrls(
  supabase: ReturnType<typeof createAdminClient>,
  rows: EvidenceRow[],
): Promise<EvidenceRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.source !== 'upload') return row
      const { data, error } = await supabase.storage
        .from('incident-evidence')
        .createSignedUrl(row.url, SIGNED_URL_EXPIRY_SECONDS)
      if (error || !data) {
        console.error('[incidents/id/evidence] failed to sign url for', row.id, error)
        return row // fall back to the raw path rather than dropping the item
      }
      return { ...row, url: data.signedUrl }
    }),
  )
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)
  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('id, league_id, reported_by, accused_driver_id, evidence_urls, accused_evidence_urls')
    .eq('id', params.id)
    .maybeSingle()

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  const isParty =
    incident.accused_driver_id === requestingDriver.id || incident.reported_by === requestingDriver.id

  if (!isSteward && !isParty) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: rows, error } = await supabase
    .schema('pitboss')
    .from('incident_evidence')
    .select('id, party, source, url, label, added_by, added_by_role, created_at')
    .eq('incident_id', params.id)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Fold in the legacy flat arrays as read-only 'link' entries so the client
  // renders one unified list regardless of when the evidence was added.
  const legacy: EvidenceRow[] = [
    ...(incident.evidence_urls ?? []).map((url: string, i: number) => ({
      id: `legacy-reporter-${i}`,
      party: 'reporter' as const,
      source: 'link' as const,
      url,
      label: null,
      added_by: incident.reported_by,
      added_by_role: 'reporter' as const,
      created_at: null,
      legacy: true,
    })),
    ...(incident.accused_evidence_urls ?? []).map((url: string, i: number) => ({
      id: `legacy-accused-${i}`,
      party: 'accused' as const,
      source: 'link' as const,
      url,
      label: null,
      added_by: incident.accused_driver_id,
      added_by_role: 'accused' as const,
      created_at: null,
      legacy: true,
    })),
  ]

  const resolved = await resolveEvidenceUrls(supabase, (rows ?? []) as EvidenceRow[])

  return NextResponse.json({ evidence: [...legacy, ...resolved] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: EvidencePostBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { party, source, url, label = null } = body

  if (party !== 'reporter' && party !== 'accused') {
    return NextResponse.json({ error: "party must be 'reporter' or 'accused'" }, { status: 400 })
  }
  if (source !== 'upload' && source !== 'link') {
    return NextResponse.json({ error: "source must be 'upload' or 'link'" }, { status: 400 })
  }
  if (!url?.trim()) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)
  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('id, league_id, reported_by, accused_driver_id, status')
    .eq('id', params.id)
    .maybeSingle()

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  const isReporter = incident.reported_by === requestingDriver.id
  const isAccused = incident.accused_driver_id === requestingDriver.id

  // Stewards can add a clip for either party (e.g. evidence that came in via
  // Discord). A party can only add evidence tagged as themselves, and only
  // while the incident is still open — matches the existing defence-editing
  // rule of "no changes after resolved".
  let addedByRole: 'reporter' | 'accused' | 'steward'
  if (isSteward) {
    addedByRole = 'steward'
  } else if (party === 'reporter' && isReporter) {
    addedByRole = 'reporter'
  } else if (party === 'accused' && isAccused) {
    addedByRole = 'accused'
  } else {
    return NextResponse.json(
      { error: 'You can only add evidence for your own side of this incident' },
      { status: 403 },
    )
  }

  if (addedByRole !== 'steward' && incident.status === 'resolved') {
    return NextResponse.json({ error: 'Cannot add evidence to a resolved incident' }, { status: 409 })
  }

  const { data, error } = await supabase
    .schema('pitboss')
    .from('incident_evidence')
    .insert({
      incident_id: params.id,
      party,
      source,
      url: url.trim(),
      label,
      added_by: requestingDriver.id,
      added_by_role: addedByRole,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Resolve immediately so the client's onAdded() callback gets a working
  // playback URL right away, instead of a raw storage path that only
  // becomes usable after the next GET.
  const [resolved] = await resolveEvidenceUrls(supabase, [data as EvidenceRow])

  return NextResponse.json({ evidence: resolved }, { status: 201 })
}
