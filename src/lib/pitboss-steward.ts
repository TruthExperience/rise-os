import { createClient } from '@/lib/supabase/server';
import { pbSteward, type PbStewardResult, type PbInferError, type RuleArticle } from '@/lib/pitboss-llm';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StewardIncidentInput {
  incident_type: string;
  description: string;
  season?: string | null;
  round?: number | null;
  lap?: number | null;
  evidence_urls?: string[];
}

export interface StewardVerdict {
  verdict: 'guilty' | 'not_guilty' | 'inconclusive';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  cited_articles: string[];
  pp_recommendation: { min: number; max: number };
  mitigating_factors: string[];
  aggravating_factors: string[];
  steward_notes: string;
  model: string;
  provider: string;
  league: string;
  disclaimer: string;
  parse_error: boolean;
}

const VALID_VERDICTS = ['guilty', 'not_guilty', 'inconclusive'] as const;
const VALID_CONFIDENCE = ['high', 'medium', 'low'] as const;

// ─── Regulation lookup ─────────────────────────────────────────────────────────

/** Pulls the most relevant rule articles for stewarding context (sporting/penalties/governance). */
export async function fetchStewardRegulations(
  leagueId?: string,
  limit = 10
): Promise<RuleArticle[]> {
  const supabase = await createClient();

  let query = supabase
    .schema('pitboss')
    .from('rule_articles')
    .select('article_number, title, body, category, league_id, rule_book_id')
    .eq('active', true)
    .or('category.eq.sporting,category.eq.penalties,category.eq.governance')
    .limit(limit);

  if (leagueId) {
    query = query.eq('league_id', leagueId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as RuleArticle[];
}

// ─── Normalization ────────────────────────────────────────────────────────────

/** Normalizes a raw pbSteward response into a strict, UI/Discord-safe shape. */
function normalizeVerdict(
  result: PbStewardResult | PbInferError,
  league: string
): StewardVerdict {
  if ('error' in result) {
    return {
      verdict: 'inconclusive',
      confidence: 'low',
      reasoning: `AI stewarding unavailable: ${result.error}`,
      cited_articles: [],
      pp_recommendation: { min: 0, max: 0 },
      mitigating_factors: [],
      aggravating_factors: [],
      steward_notes: 'Automated suggestion failed — human review required.',
      model: 'none',
      provider: 'none',
      league,
      disclaimer: 'AI suggestion unavailable. Final decision rests with the human steward.',
      parse_error: true,
    };
  }

  const s = result.suggestion;
  const verdict = (VALID_VERDICTS as readonly string[]).includes(s.verdict)
    ? s.verdict
    : 'inconclusive';
  const confidence = (VALID_CONFIDENCE as readonly string[]).includes(s.confidence)
    ? s.confidence
    : 'low';

  return {
    verdict,
    confidence,
    reasoning: s.reasoning ?? s.raw ?? 'No reasoning provided.',
    cited_articles: Array.isArray(s.cited_articles) ? s.cited_articles : [],
    pp_recommendation: {
      min: Number(s.pp_recommendation?.min ?? 0),
      max: Number(s.pp_recommendation?.max ?? 0),
    },
    mitigating_factors: Array.isArray(s.mitigating_factors) ? s.mitigating_factors : [],
    aggravating_factors: Array.isArray(s.aggravating_factors) ? s.aggravating_factors : [],
    steward_notes: s.steward_notes ?? '',
    model: result.model,
    provider: result.provider,
    league: result.league,
    disclaimer: result.disclaimer,
    parse_error: Boolean(s.parse_error),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generates an AI stewarding suggestion for an incident.
 * Does NOT write to pitboss.incidents — the `verdict`/`penalty` columns there
 * are reserved for the human steward's final decision. This returns a
 * suggestion only, for the steward to review before acting on it.
 */
export async function generateStewardVerdict(
  incident: StewardIncidentInput,
  league: string,
  leagueId?: string
): Promise<StewardVerdict> {
  const regulations = await fetchStewardRegulations(leagueId);
  const result = await pbSteward(
    incident as unknown as Record<string, unknown>,
    regulations,
    league
  );
  return normalizeVerdict(result, league);
}
