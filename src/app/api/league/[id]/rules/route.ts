import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const UPLOAD_ROLES = ['commissioner', 'co_owner', 'admin', 'head_steward']

// Next.js caches individual fetch() calls (Data Cache) independently of the
// route's `dynamic` config. supabase-js uses fetch() under the hood and
// doesn't set cache: 'no-store' itself, so without this override the first
// successful Supabase request gets cached indefinitely and every later
// request — even after the underlying data changes — silently serves that
// stale response instead of hitting Supabase again.
function noStoreFetch(url: RequestInfo | URL, options: RequestInit = {}) {
  return fetch(url, { ...options, cache: 'no-store' })
}

function getPitboss() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: 'pitboss' },
      global: { fetch: noStoreFetch },
    }
  )
}

function getStorage() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: { fetch: noStoreFetch },
    }
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = getPitboss()

  const { data: documents, error } = await supabase
    .from('rule_books')
    .select(
      'id, title, document_code, version, status, authority_level, effective_date, tagline, document_url, document_filename, document_size_bytes, document_uploaded_at'
    )
    .eq('league_id', params.id)
    .order('authority_level', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(
    { documents: documents ?? [] },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    }
  )
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const pitboss = getPitboss()
  const publicClient = getStorage()

  const { data: driver } = await pitboss
    .from('drivers')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  if (!driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  }

  const { data: userRecord } = await publicClient
    .from('users')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  const { data: membership } = await pitboss
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', params.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 })
  }

  const roles = membership.role.split(',').map((r: string) => r.trim().toLowerCase())
  const hasAccess = roles.some((r: string) => UPLOAD_ROLES.includes(r))
  if (!hasAccess) {
    return NextResponse.json({ error: 'Insufficient permissions to upload documents' }, { status: 403 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const ruleBookId = formData.get('rule_book_id') as string | null

  if (!file || !ruleBookId) {
    return NextResponse.json({ error: 'file and rule_book_id are required' }, { status: 400 })
  }

  if (file.type !== 'application/pdf') {
    return NextResponse.json({ error: 'Only PDF files are allowed' }, { status: 400 })
  }

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: 'File must be under 20MB' }, { status: 400 })
  }

  // Supabase Storage keys only allow letters, numbers, and . - _ /
  // Filenames with em dashes, smart quotes, etc. (common when copy-pasted
  // from a formatted doc title) get rejected outright with "Invalid key".
  const safeName = file.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-zA-Z0-9._-]+/g, '-') // anything else -> hyphen
    .replace(/-+/g, '-')               // collapse repeats
    .replace(/^-|-$/g, '')             // trim leading/trailing hyphen

  const storage = getStorage()
  const filename = `${params.id}/${ruleBookId}/${Date.now()}-${safeName}`
  const buffer = await file.arrayBuffer()

  const { error: uploadError } = await storage.storage
    .from('rule-documents')
    .upload(filename, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const { data: signedData } = await storage.storage
    .from('rule-documents')
    .createSignedUrl(filename, 60 * 60 * 24 * 365 * 10)

  const { data: updated, error: updateError } = await pitboss
    .from('rule_books')
    .update({
      document_url:         signedData?.signedUrl ?? null,
      document_path:        filename,
      document_filename:    file.name,
      document_size_bytes:  file.size,
      document_mime_type:   file.type,
      document_uploaded_at: new Date().toISOString(),
      document_uploaded_by: userRecord?.id ?? null,
    })
    .eq('id', ruleBookId)
    .eq('league_id', params.id)
    .select('id, title, document_url, document_filename, document_size_bytes, document_uploaded_at, status')
    .single()

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ document: updated })
}
