import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const discordId = (session.user as any).discordId
  if (!discordId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Parse form data ──────────────────────────────────────────────────────────
  const formData  = await req.formData()
  const file      = formData.get('file') as File | null
  const leagueId  = formData.get('league_id') as string | null
  const version   = formData.get('version') as string | null

  if (!file || !leagueId || !version) {
    return NextResponse.json({ error: 'file, league_id, and version are required' }, { status: 400 })
  }

  // ── Auth: commissioner or owner only ────────────────────────────────────────
  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: membership } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .maybeSingle()

  if (!membership || !['commissioner', 'owner'].includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Upload to Supabase Storage ───────────────────────────────────────────────
  const bytes       = await file.arrayBuffer()
  const buffer      = Buffer.from(bytes)
  const storagePath = `${leagueId}/${Date.now()}-${file.name}`

  const { error: uploadError } = await supabase.storage
    .from('rule-documents')
    .upload(storagePath, buffer, { contentType: file.type, upsert: false })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  // ── Send PDF to Claude for analysis ─────────────────────────────────────────
  const base64 = buffer.toString('base64')

  const aiResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          {
            type: 'text',
            text: `You are building a certification exam system for a motorsport league management platform.

Analyze this rulebook document and return a JSON object with this exact structure (no markdown, no preamble, raw JSON only):

{
  "document_code": "short uppercase code e.g. TRL-USC",
  "title": "full document title",
  "role_code": "one of: DRV (driver), STW (steward), CMR (commissioner), TP (team principal), OWN (owner), ADM (admin) — pick the role this document primarily governs",
  "role_rationale": "one sentence explaining why you picked this role",
  "questions": [
    {
      "category": "category name e.g. Sporting, Financial, Governance",
      "question": "question text",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct_answer": "A",
      "explanation": "why this is correct",
      "difficulty": "easy|medium|hard"
    }
  ]
}

Generate 20-30 questions that thoroughly test knowledge of this document. Questions should be specific to the rules and regulations in this document, not generic. Cover a range of difficulties. Do not expose correct answers in the question or options text.`,
          },
        ],
      },
    ],
  })

  let parsed: {
    document_code: string
    title: string
    role_code: string
    role_rationale: string
    questions: {
      category: string
      question: string
      options: Record<string, string>
      correct_answer: string
      explanation: string
      difficulty: string
    }[]
  }

  try {
    const text = aiResponse.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as any).text)
      .join('')
      .replace(/```json|```/g, '')
      .trim()
    parsed = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })
  }

  // ── Upsert rule_books row ────────────────────────────────────────────────────
  const { data: existing } = await supabase
    .schema('pitboss')
    .from('rule_books')
    .select('id')
    .eq('league_id', leagueId)
    .eq('document_code', parsed.document_code)
    .maybeSingle()

  let ruleBookId: string

  if (existing) {
    // Deactivate old questions for this rulebook
    await supabase
      .schema('pitboss')
      .from('questions')
      .update({ active: false })
      .eq('rule_book_id', existing.id)

    // Update rulebook version + storage path
    await supabase
      .schema('pitboss')
      .from('rule_books')
      .update({
        version,
        title:                  parsed.title,
        status:                 'active',
        document_path:          storagePath,
        document_filename:      file.name,
        document_size_bytes:    file.size,
        document_mime_type:     file.type,
        document_uploaded_at:   new Date().toISOString(),
        updated_at:             new Date().toISOString(),
      })
      .eq('id', existing.id)

    ruleBookId = existing.id
  } else {
    const { data: newBook, error: bookError } = await supabase
      .schema('pitboss')
      .from('rule_books')
      .insert({
        league_id:              leagueId,
        document_code:          parsed.document_code,
        title:                  parsed.title,
        version,
        status:                 'active',
        authority_level:        5,
        document_path:          storagePath,
        document_filename:      file.name,
        document_size_bytes:    file.size,
        document_mime_type:     file.type,
        document_uploaded_at:   new Date().toISOString(),
      })
      .select('id')
      .single()

    if (bookError || !newBook) {
      return NextResponse.json({ error: 'Failed to create rulebook record' }, { status: 500 })
    }

    ruleBookId = newBook.id
  }

  // ── Upsert role_requirements ─────────────────────────────────────────────────
  const { data: existingReq } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('id')
    .eq('league_id', leagueId)
    .eq('role_code', parsed.role_code)
    .maybeSingle()

  if (!existingReq) {
    await supabase
      .schema('pitboss')
      .from('role_requirements')
      .insert({
        league_id:      leagueId,
        role_code:      parsed.role_code,
        question_count: parsed.questions.length,
        pass_mark:      95,
      })
  } else {
    await supabase
      .schema('pitboss')
      .from('role_requirements')
      .update({ question_count: parsed.questions.length })
      .eq('id', existingReq.id)
  }

  // ── Insert new questions ─────────────────────────────────────────────────────
  const questionsToInsert = parsed.questions.map((q) => ({
    league_id:    leagueId,
    rule_book_id: ruleBookId,
    role_code:    parsed.role_code,
    category:     q.category,
    question:     q.question,
    options:      q.options,
    correct_answer: q.correct_answer,
    explanation:  q.explanation,
    difficulty:   q.difficulty,
    active:       true,
    generated_by: 'claude',
  }))

  const { error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .insert(questionsToInsert)

  if (questionsError) {
    return NextResponse.json({ error: questionsError.message }, { status: 500 })
  }

  return NextResponse.json({
    success:        true,
    document_code:  parsed.document_code,
    title:          parsed.title,
    role_code:      parsed.role_code,
    role_rationale: parsed.role_rationale,
    questions_generated: parsed.questions.length,
    rule_book_id:   ruleBookId,
  })
}
