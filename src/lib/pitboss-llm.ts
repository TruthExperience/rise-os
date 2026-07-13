// pitboss-llm.ts — typed client, all logic lives in the worker

const WORKER_URL = process.env.PITBOSS_WORKER_URL || 'https://pitboss-proxy.truthexper.workers.dev';

// ADDED — catch a malformed env var at module load instead of at request
// time, where it surfaces as an opaque "string did not match expected
// pattern" error deep inside fetch/undici's URL parser.
function validateWorkerUrl(url: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    throw new Error(
      `PITBOSS_WORKER_URL is not a valid URL: ${JSON.stringify(url)}. ` +
      `Check for stray whitespace, quotes, or a missing protocol in the env var.`
    );
  }
}
const VALIDATED_WORKER_URL = validateWorkerUrl(WORKER_URL); // ADDED

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

export type SetupAdjustment = {
  param_key:  string;
  delta:      number;
  confidence: 'low' | 'medium' | 'high';
  reasoning:  string;
};

export type PbSetupFeedbackResult = {
  adjustments:  SetupAdjustment[];
  summary:      string;
  raw?:         string;
  parse_error?: boolean;
  model:        string;
  provider:     string;
  league:       string;
  disclaimer:   string;
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

// ADDED — wrap the fetch + error-text read in try/catch so transport-level
// failures (bad URL, DNS failure, network drop, worker unreachable) come
// back as a consistent Error with a readable message instead of whatever
// raw exception the underlying fetch/URL implementation throws.
async function workerPost(path: string, body: object): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${VALIDATED_WORKER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-PitBoss-Key': getInternalKey(),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // ADDED — normalize transport failures (bad URL, DNS, network) into a
    // predictable message rather than letting fetch's internal error
    // (e.g. ada-url's "string did not match the expected pattern") leak
    // straight to the caller / UI.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`PitBoss worker request to ${path} failed before reaching the server: ${detail}`);
  }

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '<unreadable response body>';
    }
    throw new Error(`PitBoss ${path} error ${res.status}: ${bodyText}`);
  }

  try {
    return await res.json();
  } catch (err) {
    // ADDED — worker returned a non-JSON 2xx body; surface clearly instead
    // of throwing an opaque JSON.parse error upstream.
    throw new Error(`PitBoss ${path} returned a non-JSON response body`);
  }
}

export const pbInfer = (opts: InferOptions) =>
  workerPost('/infer', { mode: 'primary', max_tokens: 1024, temperature: 0.3, ...opts }) as Promise<InferResult>;

export const pbSteward = (
  incident:    Record<string, unknown>,
  regulations: RuleArticle[],
  league:      string
): Promise<PbStewardResult | PbInferError> =>
  workerPost('/steward', { incident, regulations, league });

export const pbSetupFeedback = (
  feedbackText:    string,
  knownParamKeys:  string[],
  context:         Record<string, unknown>,
  league:          string
): Promise<PbSetupFeedbackResult | PbInferError> =>
  workerPost('/setup-feedback', {
    feedback_text:     feedbackText,
    known_param_keys:  knownParamKeys,
    context,
    league,
  });

export const pbHealth = () =>
  fetch(`${VALIDATED_WORKER_URL}/health`, {
    headers: { 'X-PitBoss-Key': getInternalKey() },
  }).then((r) => r.json());
