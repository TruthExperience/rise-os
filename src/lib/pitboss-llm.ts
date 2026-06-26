/**
 * PitBoss LLM Client
 * Internal utility for calling the pitboss-proxy Cloudflare Worker
 * Used by all PitBoss AI features in rise-os
 */

const WORKER_URL = process.env.PITBOSS_WORKER_URL || 'https://pitboss-proxy.truthexper.workers.dev';
const INTERNAL_KEY = process.env.PITBOSS_INTERNAL_KEY || 'pb_internal_2027';

export type LLMMode = 'fast' | 'primary' | 'reasoning' | 'certgen' | 'quick' | 'steward';

export interface InferOptions {
  prompt?: string;
  system?: string;
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  mode?: LLMMode;
  max_tokens?: number;
  temperature?: number;
}

export interface InferResult {
  response: string;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export interface IncidentReport {
  reporter_discord_id?: string;
  accused_discord_id?: string;
  accused_username?: string;
  season?: string;
  round?: number;
  lap?: number;
  incident_type: string;
  description: string;
  evidence_url?: string;
  track?: string;
}

export interface RegulationArticle {
  article_number: string;
  title: string;
  body: string;
}

export interface StewSuggestion {
  verdict: 'guilty' | 'not_guilty' | 'inconclusive';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  cited_articles: string[];
  pp_recommendation: { min: number; max: number };
  mitigating_factors: string[];
  aggravating_factors: string[];
  steward_notes: string;
  raw?: string;
  parse_error?: boolean;
}

export interface StewResult {
  model: string;
  provider: string;
  league: string;
  suggestion: StewSuggestion;
  disclaimer: string;
}

export async function pbInfer(options: InferOptions): Promise<InferResult> {
  const res = await fetch(`${WORKER_URL}/infer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PitBoss-Key': INTERNAL_KEY,
    },
    body: JSON.stringify({
      mode: 'fast',
      max_tokens: 1024,
      temperature: 0.3,
      ...options,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PitBoss LLM error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function pbSteward(
  incident: IncidentReport,
  regulations: RegulationArticle[] = [],
  league = 'AWC'
): Promise<StewResult> {
  const res = await fetch(`${WORKER_URL}/steward`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PitBoss-Key': INTERNAL_KEY,
    },
    body: JSON.stringify({ incident, regulations, league }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PitBoss Steward error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function pbHealth(): Promise<{ status: string; source: string; models: Record<string, unknown> }> {
  const res = await fetch(`${WORKER_URL}/health`, {
    headers: { 'X-PitBoss-Key': INTERNAL_KEY },
  });
  return res.json();
}
