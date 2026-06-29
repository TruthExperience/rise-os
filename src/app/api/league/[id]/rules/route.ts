import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const UPLOAD_ROLES = ['commissioner', 'co_owner', 'admin', 'head_steward']

function getPitboss() {
 return createClient(
   process.env.NEXT_PUBLIC_SUPABASE_URL!,
   process.env.SUPABASE_SERVICE_ROLE_KEY!,
   { db: { schema: 'pitboss' } }
 )
}

function getStorage() {
 return createClient(
   process.env.NEXT_PUBLIC_SUPABASE_URL!,
   process.env.SUPABASE_SERVICE_ROLE_KEY!
 )
}

export async function GET(
 _req: NextRequest,
 { params }: { params: { id: string } }
) {
 // --- TEMPORARY DIAGNOSTIC LOGGING ---
 console.log('[rules:GET] league_id =', params.id)
 console.log('[rules:GET] SUPABASE_URL =', process.env.NEXT_PUBLIC_SUPABASE_URL)
 console.log(
   '[rules:GET] SERVICE_ROLE_KEY prefix =',
   process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 12),
   'length =',
   process.env.SUPABASE_SERVICE_ROLE_KEY?.length
 )

 const supabase = getPitboss()

 const { data: documents, error, status, statusText } = await supabase
   .from('rule_books')
   .select(
     'id, title, document_code, version, status, authority_level, effective_date, tagline, document_url, document_filename, document_size_bytes, document_uploaded_at'
   )
   .eq('league_id', params.id)
   .order('authority_level', { ascending: true })

 console.log('[rules:GET] supabase status =', status, statusText)
 console.log('[rules:GET] supabase error =', JSON.stringify(error))
 console.log('[rules:GET] raw documents =', JSON.stringify(documents))

 // Isolation test A: same filter, same columns, NO order()
 const { data: noOrder, error: noOrderError } = await supabase
   .from('rule_books')
   .select(
     'id, title, document_code, version, status, authority_level, effective_date, tagline, document_url, document_filename, document_size_bytes, document_uploaded_at'
   )
   .eq('league_id', params.id)
 console.log('[rules:GET] TEST-A (no order) documents =', JSON.stringify(noOrder))
 console.log('[rules:GET] TEST-A error =', JSON.stringify(noOrderError))

 // Isolation test B: same filter + order, but ONLY select id + document_url
 const { data: minimalCols, error: minimalColsError } = await supabase
   .from('rule_books')
   .select('id, document_url')
   .eq('league_id', params.id)
   .order('authority_level', { ascending: true })
 console.log('[rules:GET] TEST-B (minimal columns + order) =', JSON.stringify(minimalCols))
 console.log('[rules:GET] TEST-B error =', JSON.stringify(minimalColsError))

 // Isolation test C: select(*) with order, to see if explicit column list itself is the issue
 const { data: starSelect, error: starSelectError } = await supabase
   .from('rule_books')
   .select('*')
   .eq('league_id', params.id)
   .order('authority_level', { ascending: true })
 console.log('[rules:GET] TEST-C (select star + order) document_url =', starSelect?.[0]?.document_url)
 console.log('[rules:GET] TEST-C error =', JSON.stringify(starSelectError))

 // Direct re-fetch of the known row by id, bypassing the league filter,
 // to compare against the list query above.
 if (documents && documents.length > 0) {
   const firstId = documents[0].id
   const { data: singleRow, error: singleError } = await supabase
     .from('rule_books')
     .select('id, document_url, document_uploaded_at')
     .eq('id', firstId)
     .single()
   console.log('[rules:GET] direct single-row refetch for', firstId, '=', JSON.stringify(singleRow))
   console.log('[rules:GET] direct single-row error =', JSON.stringify(singleError))
 }
 // --- END TEMPORARY DIAGNOSTIC LOGGING ---

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

 const storage = getStorage()
 const filename = `${params.id}/${ruleBookId}/${Date.now()}-${file.name.replace(/\s+/g, '-')}`
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

 // --- TEMPORARY DIAGNOSTIC LOGGING ---
 console.log('[rules:PUT] updateError =', JSON.stringify(updateError))
 console.log('[rules:PUT] updated row returned =', JSON.stringify(updated))
 // --- END TEMPORARY DIAGNOSTIC LOGGING ---

 if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

 return NextResponse.json({ document: updated })
}
