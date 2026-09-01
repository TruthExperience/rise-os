import { createAdminClient } from '@/lib/supabase/server'

// Called every 4th completed exam for a given (league_id, role_code).
// "Replace" strategy: generate N new questions, then deactivate the N
// oldest active questions in the same pool so the bank size stays roughly
// steady instead of growing unbounded. New question IDs are automatically
// "unseen" for every driver — driver_question_history doesn't need to be
// touched here.
export async function regenerateQuestionPool(leagueId: string, roleCode: string) {
  const supabase = createAdminClient()

  const { data: requirement } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('question_count')
    .eq('league_id', leagueId)
    .eq('role_code', roleCode)
    .maybeSingle()

  if (!requirement) {
    console.error(`[question-pool-regen] no role_requirements for ${roleCode}/${leagueId}`)
    return
  }

  const genCount = requirement.question_count

  // TODO: replace this block with your actual manual-regen call (same one
  // used for the HRL steward batch) — whatever hits pitboss-proxy and
  // returns { question, options, correct_answer, explanation, category,
  // difficulty, rule_book_id } rows.
  const generated = await generateQuestionsViaProxy(leagueId, roleCode, genCount)

  if (!generated || generated.length === 0) {
    console.error(`[question-pool-regen] proxy returned no questions for ${roleCode}/${leagueId}`)
    return
  }

  const { error: insertError } = await supabase
    .schema('pitboss')
    .from('questions')
    .insert(
      generated.map((q) => ({
        league_id:    leagueId,
        role_code:    roleCode,
        category:     q.category,
        question:     q.question,
        options:      q.options,
        correct_answer: q.correct_answer,
        explanation:  q.explanation ?? null,
        difficulty:   q.difficulty ?? 'medium',
        generated_by: 'claude',
        rule_book_id: q.rule_book_id ?? null,
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
  count: number
): Promise<Array<{
  category: string
  question: string
  options: unknown
  correct_answer: string
  explanation?: string
  difficulty?: string
  rule_book_id?: string
}>> {
  // Placeholder — wire to pitboss-proxy here.
  throw new Error('generateQuestionsViaProxy not yet wired — replace with pitboss-proxy call')
}
