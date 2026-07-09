// src/app/api/pitboss/admin/rulebook/upload/route.ts
// POST /api/pitboss/admin/rulebook/upload
// Uploads a rulebook PDF to storage, extracts text, calls the internal PitBoss
// LLM gateway (pitboss-proxy Worker → Groq/OpenRouter, certgen mode) to generate
// exam questions, and inserts them into pitboss.questions.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pbInfer } from '@/lib/pitboss-llm'

const DEFAULT_QUESTION_COUNT = 30

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
function buildPrompt(leagueName: string, roleCode: string, ruleText: string, count: number): string {
  const easy = Math.round(count * 0.3)
  const hard = Math.round(count * 0.25)
  const medium = count - easy - hard

  return `You are an expert exam question writer for competitive sim racing leagues.

You have been given the official rulebook for the ${leagueName} league (${roleCode} certification track). Generate exactly ${count} multiple-choice exam questions that test knowledge of the rules for this role.

REQUIREMENTS:
- Generate exactly ${count} questions, no more, no fewer
- Each question must have exactly 4 options
- Questions must cover a range of difficulty: ~${easy} easy, ~${medium} medium, ~${hard} hard
- Questions must cover different categories from the rulebook (racing rules, penalties, governance, attendance, etc.)
- The correct answer must be unambiguously correct based on the rulebook text
- Options should be plausible — avoid obviously wrong distractors
- Do NOT include question numbers in the question text

RULEBOOK TEXT:
${ruleText.slice(0, 12000)}

Respond ONLY with a valid JSON array of exactly ${count} items. No preamble, no markdown, no explanation. Format:
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
  const role_code = formData.get('role_code') as string | null
  const version   = (formData.get('version') as string | null) ?? '1.0'

  if (!file || !league_id || !role_code) {
    return NextResponse.json(
      { error: 'file, league_id, and role_code are required' },
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

  // ── Resolve target question count from role_requirements ─────────────────
  const { data: roleReq } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('question_count, role_name')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .maybeSingle()

  const targetCount = roleReq?.question_count ?? DEFAULT_QUESTION_COUNT

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

  // ── Call the internal PitBoss LLM gateway to generate questions ───────────
  let generatedQuestions: Array<{
    category:       string
    difficulty:     string
    question:       string
    options:        string[]
    correct_answer: string
  }> = []

  try {
    const result = await pbInfer({
      mode:        'certgen',
      system:      `You are PitBoss AI, generating certification exam questions for the ${league.name} league.`,
      prompt:      buildPrompt(league.name, role_code, ruleText, targetCount),
      max_tokens:  Math.max(2048, targetCount * 160),
      temperature: 0.5,
    })

    const raw = result.response.replace(/```json|```/g, '').trim()
    generatedQuestions = JSON.parse(raw)

    if (!Array.isArray(generatedQuestions)) {
      throw new Error('Response is not an array')
    }
  } catch (err) {
    console.error('[rulebook/upload] internal LLM generation', err)
    return NextResponse.json(
      {
        error:        'Failed to generate questions from rulebook via the internal LLM',
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
      role_code,
      category:       q.category || 'General',
      difficulty:     q.difficulty,
      question:       q.question,
      options:        q.options,
      correct_answer: q.correct_answer,
      active:         true,
      generated_by:   'internal_llm',
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
    role_code,
    target_count:        targetCount,
    questions_generated: generatedQuestions.length,
    questions_inserted:  inserted?.length ?? 0,
    skipped:             generatedQuestions.length - (inserted?.length ?? 0),
    generated_by:        'internal_llm',
  }, { status: 201 })
}
