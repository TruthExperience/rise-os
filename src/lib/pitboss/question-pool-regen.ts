import { createAdminClient } from '@/lib/supabase/server'

// NOTE: assumes these env vars exist server-side, matching what cert/steward/
// setup-feedback routes already use to call pitboss-proxy. Rename below if
// your actual var names differ.
const PITBOSS_PROXY_URL = process.env.PITBOSS_PROXY_URL ?? 'https://pitboss-proxy.YOUR_SUBDOMAIN.workers.dev'
const PITBOSS_INTERNAL_KEY = process.env.PITBOSS_INTERNAL_KEY

// Reasoning models on the proxy's free pool prepend chain-of-thought prose
// before the JSON (same issue as the telemetry narrative fix) — scan
// backward from the last closing bracket instead of assuming the response
// starts clean, and handle both ```json fences and raw prose wrappers.
function extractTrailingJson(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    return JSON.parse(fenced)
  } catch {
    // Fall through to bracket-scanning below.
  }

  const lastArrayClose = fenced.lastIndexOf(']')
  const lastObjClose = fenced.lastIndexOf('}')
  const useArray = lastArrayClose > lastObjClose

  const closeChar = useArray ? ']' : '}'
  const openChar = useArray ? '[' : '{'
  const closeIdx = useArray ? lastArrayClose : lastObjClose
  if (closeIdx === -1) throw new Error('No JSON structure found in proxy response')

  let depth = 0
  let openIdx = -1
  for (let i = closeIdx; i >= 0; i--) {
    if (fenced[i] === closeChar) depth++
    else if (fenced[i] === openChar) {
      depth--
      if (depth === 0) { openIdx = i; break }
    }
  }
  if (openIdx === -1) throw new Error('Unbalanced JSON structure in proxy response')

  return JSON.parse(fenced.slice(openIdx, closeIdx + 1))
}

// Called every 4th completed exam for a given (league_id, role_code).
// "Replace" strategy: generate N new questions, then deactivate the N
// oldest active questions in the same pool so the bank size stays roughly
// steady instead of growing unbounded. New question IDs are automatically
// "unseen" for every driver — driver_question_history doesn't need to be
// touched here. League-agnostic: works identically for all 8 leagues,
// driven entirely by leagueId/roleCode.
export async function regenerateQuestionPool(leagueId: string, roleCode: string) {
  const supabase = createAdminClient()

  const { data: requirement } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('question_count, role_name')
    .eq('league_id', leagueId)
    .eq('role_code', roleCode)
    .maybeSingle()

  if (!requirement) {
    console.error(`[question-pool-regen] no role_requirements for ${roleCode}/${leagueId}`)
    return
  }

  const { data: league } = await supabase
    .schema('pitboss')
    .from('leagues')
    .select('name')
    .eq('id', leagueId)
    .maybeSingle()

  const genCount = requirement.question_count

  // Pull existing active questions for this pool — used to (a) infer the
  // category mix to preserve and (b) tell the model what to avoid
  // duplicating. Capped so the prompt doesn't balloon on large pools.
  const { data: existing } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('category, question, difficulty')
    .eq('league_id', leagueId)
    .eq('role_code', roleCode)
    .eq('active', true)
    .limit(60)

  const categories = [...new Set((existing ?? []).map((q) => q.category))]
  const difficulties = [...new Set((existing ?? []).map((q) => q.difficulty))]

  const generated = await generateQuestionsViaProxy(
    leagueId,
    roleCode,
    genCount,
    {
      leagueName: league?.name ?? leagueId,
      roleName: requirement.role_name ?? roleCode,
      categories,
      difficulties,
      avoidQuestions: (existing ?? []).map((q) => q.question),
    }
  )

  if (!generated || generated.length === 0) {
    console.error(`[question-pool-regen] proxy returned no questions for ${roleCode}/${leagueId}`)
    return
  }

  const { error: insertError } = await supabase
    .schema('pitboss')
    .from('questions')
    .insert(
      generated.map((q) => ({
        league_id:      leagueId,
        role_code:      roleCode,
        category:       q.category,
        question:       q.question,
        options:        q.options,
        correct_answer: q.correct_answer,
        explanation:    q.explanation ?? null,
        difficulty:     q.difficulty ?? 'medium',
        generated_by:   'claude',
        rule_book_id:   q.rule_book_id ?? null,
      }))
    )

  if (insertError) {
    console.error('[question-pool-regen] insert failed', insertError)
    return
  }

  // Deactivate the oldest active questions in this pool, equal to how
  // many were just added, to keep pool size steady.
  const { data: oldest } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id')
    .eq('league_id', leagueId)
    .eq('role_code', roleCode)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(generated.length)

  if (oldest && oldest.length > 0) {
    await supabase
      .schema('pitboss')
      .from('questions')
      .update({ active: false })
      .in('id', oldest.map((q) => q.id))
  }
}

async function generateQuestionsViaProxy(
  leagueId: string,
  roleCode: string,
  count: number,
  context: {
    leagueName: string
    roleName: string
    categories: string[]
    difficulties: string[]
    avoidQuestions: string[]
  }
):
