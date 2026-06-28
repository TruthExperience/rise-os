// pitboss-llm.ts — typed client, all logic lives in the worker

const WORKER_URL = process.env.PITBOSS_WORKER_URL || 'https://pitboss-proxy.truthexper.workers.dev';

export type LLMMode = 'fast' | 'primary' | 'reasoning' | 'certgen' | 'quick' | 'steward' | 'coding' | 'vision';

export interface InferOptions {
  prompt?:      string;
  system?:      string;
  messages?:    { role: 'user' | 'assistant'; content: string | object[] }[];
  mode?:        LLMMode;
  max_tokens?:  number;
  temperature?: number;
}

export interface InferResult {
  response: string;
  model:    string;
  provider: string;
  free:     boolean;
  usage?:   { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export type RuleArticle = {
  article_number: string;
  title:          string;
  body:           string;
  category:       string;
  league_id:      string;
  rule_book_id:   string;
};

export type PbStewardResult = {
  suggestion: {
    verdict:             string;
    confidence:          string;
    reasoning:           string;
    raw?:                string;
    cited_articles:      string[];
    pp_recommendation:   { min: number; max: number };
    mitigating_factors:  string[];
    aggravating_factors: string[];
    steward_notes:       string;
    parse_error?:        boolean;
  };
  model:      string;
  provider:   string;
  league:     string;
  disclaimer: string;
};

export type PbInferError = {
  error:       string;
  model?:      string;
  provider?:   string;
  league?:     string;
  disclaimer?: string;
};

function getInternalKey(): string {
  const key = process.env.PITBOSS_INTERNAL_KEY;
  if (!key) throw new Error('PITBOSS_INTERNAL_KEY is not set');
  return key;
}

async function workerPost(path: string, body: object): Promise<any> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-PitBoss-Key': getInternalKey(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PitBoss ${path} error ${res.status}: ${await res.text()}`);
  return res.json();
}

export const pbInfer = (opts: InferOptions) =>
  workerPost('/infer', { mode: 'primary', max_tokens: 1024, temperature: 0.3, ...opts }) as Promise<InferResult>;

export const pbSteward = (
  incident:    Record<string, unknown>,
  regulations: RuleArticle[],
  league:      string
): Promise<PbStewardResult | PbInferError> =>
  workerPost('/steward', { incident, regulations, league });

export const pbHealth = () =>
  fetch(`${WORKER_URL}/health`, {
    headers: { 'X-PitBoss-Key': getInternalKey() },
  }).then((r) => r.json());
