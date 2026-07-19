import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

interface PersonnelUpdateBody {
  full_name?: string
  team_name?: string | null
  position?: string
  driver_number?: number | null
  attributes?: Record<string, number | string>
  notes?: string | null
  is_active?: boolean
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let body: PersonnelUpdateBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Game-canon rows (source = 'game') are seeded via migration and locked
  // from this route — only custom entries can be edited here. Swap this
  // check out for whatever role/permission helper the rest of pitboss uses
  // if you want commissioners to be able to correct canon rows too.
  const { data: existing, error: fetchError } = await supabase
    .schema('pitboss')
    .from('fm_personnel')
    .select('source')
    .eq('id', params.id)
    .single()

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 404 })
  }
  if (existing.source !== 'custom') {
    return NextResponse.json(
      { error: 'Only custom entries can be edited through this route' },
      { status: 403 },
    )
  }

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
  const supabase = createAdminClient()

  const { data: existing, error: fetchError } = await supabase
    .schema('pitboss')
    .from('fm_personnel')
    .select('source')
    .eq('id', params.id)
    .single()

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 404 })
  }
  if (existing.source !== 'custom') {
    return NextResponse.json(
      { error: 'Only custom entries can be deleted through this route' },
      { status: 403 },
    )
  }

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
