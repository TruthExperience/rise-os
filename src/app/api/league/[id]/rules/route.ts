import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseUserId } from '@/lib/getSupabaseUserId'

export const dynamic = 'force-dynamic'

// rise_os equivalent of the old UPLOAD_ROLES tier — commissioner-level
// access only. Coaches are intentionally excluded: rulebook uploads are
// a league-governance action, not a per-team one.
const UPLOAD_ROLES = ['commissioner', 'co_commissioner', 'admin']

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

function getRiseOs() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: 'rise_os' },
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

async function requireUploadAccess(leagueId: string) {
  const userId = await getSupabaseUserId()
  if (!userId) {
    return { error: NextResponse.json({ error: 'Unauthenticated' }, { status: 401 }) }
  }

  const riseOs = getRiseOs()

  const { data: adminRow } = await riseOs
    .from('league_admins')
    .select('role')
    .eq('league_id', leagueId)
    .eq('user_id', userId)
    .maybeSingle()

  if (adminRow) return { userId }

  const { data: memberRow } = await riseOs
    .from('league_members')
    .select('role, status')
    .eq('league_id', leagueId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (memberRow && UPLOAD_ROLES.includes(memberRow.role)) {
    return { userId }
  }

  return {
    error: NextResponse.json(
      { error: 'Insufficient permissions to upload documents' },
      { status: 403 }
    ),
  }
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
  const access = await requireUploadAccess(params.id)
  if ('error' in access) return access.error
  const { userId } = access

  const pitboss = getPitboss()

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
      document_uploaded_by: userId,
    })
    .eq('id', ruleBookId)
    .eq('league_id', params.id)
    .select('id, title, document_url, document_filename, document_size_bytes, document_uploaded_at, status')
    .single()

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ document: updated })
}
