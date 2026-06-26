// src/app/api/pitboss/admin/rulebook/upload/route.ts
// POST /api/pitboss/admin/rulebook/upload
// Uploads a rulebook PDF to storage, extracts text, calls Anthropic to generate
// exam questions, and inserts them into pitboss.questions.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

// ── Inline PDF text extraction (no pdf-parse dep needed) ─────────────────────
function extractTextFromPDF(buffer: Buffer): string {
  const str = buffer.toString('latin1')
  const textChunks: string[] = []

  const btEtRegex = /BT([\s\S]*?)ET/g
  let match: RegExpExecArray | null

  while ((match = btEtRegex.exec(str)) !== null) {
    const block = match[1]
    const strRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)|<([0-9A-Fa-f]+)>/g
    let strMatch: RegExpExecArray | null

    while ((strMatch = strRegex.exec(block)) !== null) {
      if (strMatch[1] !== undefined) {
        const text = strMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\')
          .replace(/\\(\d{3})/g, (_, oct) =>
            String.fromCharCode(parseInt(oct, 8))
          )
        if (text.trim()) textChunks.push(text)
      } else if (strMatch[2] !== undefined) {
        const hex = strMatch[2]
        let decoded = ''
        for (let i = 0; i < hex.length; i += 2) {
          const code = parseInt(hex.slice(i, i + 2), 16)
          if (code > 31) decoded += String.fromCharCode(code)
        }
        if (decoded.trim()) textChunks.push(decoded)
      }
    }
  }

  return textChunks.join(' ').replace(/\s+/g, ' ').trim()
}

// ── Question generation prompt ────────────────────────────────────────────────
function buildPrompt(leagueName: string, ruleText: string): string {
  return `You are an expert exam question writer for competitive sim racing leagues.

You have been given the official rulebook for the ${leagueName} league. Generate exactly 20 multiple-choice exam questions that test drivers' knowledge of the rules.

REQUIREMENTS:
- Each question must have exactly 4 options
- Questions must cover a range of difficulty: ~6 easy, ~9 medium, ~5 hard
- Questions must cover different categories from the rulebook (racing rules, penalties, governance, attendance, etc.)
- The correct answer must be unambiguously correct based on the rulebook text
- Options should be plausible — avoid obviously wrong distractors
- Do NOT include question numbers in the question text

RULEBOOK TEXT:
${ruleText.slice(0, 12000)}

Respond ONLY with a valid JSON array. No preamble, no markdown, no explanation. Format:
[
  {
    "category": "string (e.g. Racing Rules, Penalties, Governance)",
    "difficulty": "easy" | "medium" | "hard",
    "question": "string",
    "options": ["option text A", "option text B", "option text C", "option text D"],
    "correct_answer": "exact text of the correct option (must match one of the options exactly)"
  }
]`
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  // ── Auth: must be commissioner ────────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = user.user_metadata?.provider_id ?? user.user_metadata?.sub ?? ''

  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  // ── Parse multipart form ──────────────────────────────────────────────────
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file      = formData.get('file') as File | null
  const league_id = formData.get('league_id') as string | null
  const version   = (formData.get('version') as string | null) ?? '1.0'

  if (!file || !league_id) {
    return NextResponse.json(
      { error: 'file and league_id are required' },
      { status: 400 }
    )
  }

  if (file.type !== 'application/pdf') {
    return NextResponse.json({ error: 'Only PDF files are accepted' }, { status: 415 })
  }

  // ── Resolve league ────────────────────────────────────────────────────────
  const { data: league, error: leagueError } = await supabase
    .schema('rise_os')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', league_id)
    .maybeSingle()

  if (leagueError || !league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 })
  }

  // ── Verify commissioner membership ────────────────────────────────────────
  const { data: membership } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .maybeSingle()

  if (!membership || membership.role !== 'commissioner') {
    return NextResponse.json(
      { error: 'Only commissioners can upload rulebooks' },
      { status: 403 }
    )
  }

  // ── Upload PDF to storage ─────────────────────────────────────────────────
  const arrayBuffer = await file.arrayBuffer()
  const buffer      = Buffer.from(arrayBuffer)
  const filename    = `${league.slug}/rulebook_v${version}_${Date.now()}.pdf`

  const { error: uploadError } = await supabase.storage
    .from('rule-documents')
    .upload(filename, buffer, {
      contentType:  'application/pdf',
      cacheControl: '3600',
      upsert:       false,
    })

  if (uploadError) {
    console.error('[rulebook/upload] storage upload', uploadError)
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const { data: publicUrlData } = supabase.storage
    .from('rule-documents')
    .getPublicUrl(filename)

  // ── Extract text from PDF buffer ──────────────────────────────────────────
  let ruleText = ''
  try {
    ruleText = extractTextFromPDF(buffer)
  } catch (err) {
    console.error('[rulebook/upload] PDF extraction', err)
  }

  if (ruleText.length < 200) {
    return NextResponse.json(
      {
        error:
          'Could not extract readable text from this PDF. ' +
          'Please ensure the document is text-based (not scanned).',
        storage_path: filename,
        public_url:   publicUrlData?.publicUrl,
      },
      { status: 422 }
    )
  }

  // ── Call Anthropic to generate questions ──────────────────────────────────
  let generatedQuestions: Array<{
    category:       string
    difficulty:     string
    question:       string
    options:        string[]
    correct_answer: string
  }> = []

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role:    'user',
          content: buildPrompt(league.name, ruleText),
        },
      ],
    })

    const raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
      .replace(/```json|```/g, '')
      .trim()

    generatedQuestions = JSON.parse(raw)

    if (!Array.isArray(generatedQuestions)) {
      throw new Error('Response is not an array')
    }
  } catch (err) {
    console.error('[rulebook/upload] AI generation', err)
    return NextResponse.json(
      {
        error:        'Failed to generate questions from rulebook',
        storage_path: filename,
        public_url:   publicUrlData?.publicUrl,
      },
      { status: 500 }
    )
  }

  // ── Validate and insert questions ─────────────────────────────────────────
  const validDifficulties = ['easy', 'medium', 'hard']
  const toInsert = generatedQuestions
    .filter(
      (q) =>
        q.question &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        q.correct_answer &&
        q.options.includes(q.correct_answer) &&
        validDifficulties.includes(q.difficulty)
    )
    .map((q) => ({
      league_id,
      category:       q.category || 'General',
      difficulty:     q.difficulty,
      question:       q.question,
      options:        q.options,
      correct_answer: q.correct_answer,
      active:         true,
    }))

  const { data: inserted, error: insertError } = await supabase
    .schema('pitboss')
    .from('questions')
    .insert(toInsert)
    .select('id')

  if (insertError) {
    console.error('[rulebook/upload] questions insert', insertError)
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({
    success:             true,
    storage_path:        filename,
    public_url:          publicUrlData?.publicUrl,
    text_length:         ruleText.length,
    questions_generated: generatedQuestions.length,
    questions_inserted:  inserted?.length ?? 0,
    skipped:             generatedQuestions.length - (inserted?.length ?? 0),
  }, { status: 201 })
}
