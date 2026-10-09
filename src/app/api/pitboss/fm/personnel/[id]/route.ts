import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'
import { isPitbossLeagueAdmin } from '@/lib/pitboss/leagueAdminAccess'
import { checkPersonnelFields } from '@/lib/pitboss/personnelValidation'

export const dynamic = 'force-dynamic'

interface PersonnelUpdateBody {
  full_name?: string
  team_name?: string | null
  position?: string
  driver_number?: number | null
  attributes?: Record<string, number | string>
  notes?: string | null
  is_active?: boolean
}

// Fields a caller may change through PATCH. source, league_id and
// created_by are never editable.
const PATCHABLE_FIELDS = [
  'full_name',
  'team_name',
  'position',
  'driver_number',
  'attributes',
  'notes',
  'is_active',
]

// An entry can be changed by the driver who created it, or by a
// commissioner, owner or co-owner of the entry's league.
async function loadEditableEntry(supabase: any, id: string, driver: { id: string; discordId: string | null }) {
  const { data: existing, error: fetchError } = await supabase
    .schema('pitboss')
    .from('fm_personnel')
    .select('source, created_by, league_id')
    .eq('id', id)
    .single()

  if (fetchError || !existing) {
    return { error: NextResponse.json({ error: 'Entry not found' }, { status: 404 }) }
  }

  // Game-canon rows (source = 'game') are seeded via migration and locked
  // from this route — only custom entries can be changed here.
  if (existing.source !== 'custom') {
    return {
      error: NextResponse.json(
        { error: 'Only custom entries can be changed through this route' },
        { status: 403 },
      ),
    }
  }

  const isCreator = existing.created_by === (driver.discordId ?? driver.id)
  const isLeagueAdmin = existing.league_id
    ? await isPitbossLeagueAdmin(driver.id, existing.league_id)
    : false

  if (!isCreator && !isLeagueAdmin) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  return { existing }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: PersonnelUpdateBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const rejected = Object.keys(body).filter((k) => !PATCHABLE_FIELDS.includes(k))
  if (rejected.length > 0) {
    return NextResponse.json({ error: `Fields not editable: ${rejected.join(', ')}` }, { status: 400 })
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const fieldError = checkPersonnelFields(body as Record<string, any>)
  if (fieldError) {
    return NextResponse.json({ error: fieldError }, { status: 400 })
  }

  const supabase = createAdminClient()

  const loaded = await loadEditableEntry(supabase, params.id, driver)
  if (loaded.error) return loaded.error

  const { data, error } = await supabase
    .schema('pitboss')
    .from('fm_personnel')
    .update(body)
    .eq('id', params.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ personnel: data })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const loaded = await loadEditableEntry(supabase, params.id, driver)
  if (loaded.error) return loaded.error

  // Soft delete — keeps history/foreign-key references intact
  const { error } = await supabase
    .schema('pitboss')
    .from('fm_personnel')
    .update({ is_active: false })
    .eq('id', params.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ deleted: true })
}
