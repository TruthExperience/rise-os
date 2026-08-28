// pitboss-llm.ts — typed client, all logic lives in the worker

const WORKER_URL = process.env.PITBOSS_WORKER_URL || 'https://pitboss-proxy.truthexper.workers.dev';

// Catch a malformed env var at module load instead of at request
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
const VALIDATED_WORKER_URL = validateWorkerUrl(WORKER_URL);

// Client-side ceiling on any single worker call. The worker now bounds
// its own free-model waterfall (FREE_WATERFALL_BUDGET_MS) and paid
// fallback (PAID_FALLBACK_BUDGET_MS) to a combined ~18s worst case.
// 25s here sits comfortably above that, while still leaving ~5s of
// headroom under Vercel Hobby's 30s maxDuration for the caller's own
// try/catch fallback path to actually run before the function gets
// killed outright.
const DEFAULT_TIMEOUT_MS = 25_000; // CHANGED — was 20_000, too tight against the worker's worst case

export type LLMMode = 'fast' | 'primary' | 'reasoning' | 'certgen' | 'quick' | 'steward' | 'coding' | 'vision';

export interface InferOptions {
  prompt?:      string;
  system?:      string;
  messages?:    { role: 'user' | 'assistant'; content: string | object[] }[];
  mode?:        LLMMode;
  max_tokens?:  number;
  temperature?: number;
  timeoutMs?:   number; // per-call override, falls back to DEFAULT_TIMEOUT_MS
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

// Per-request metadata about the vision pre-pass in /steward, so
// callers can log/audit which model produced an image description
// without having to guess from the general `model`/`usage` fields
// (those describe the verdict-writing call, not the vision call).
export type ImageAnalysisMeta = {
  model:       string;
  usage:       { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  image_count: number;
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
  image_analysis: ImageAnalysisMeta | null;
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

// Wrap the fetch + error-text read in try/catch so transport-level
// failures (bad URL, DNS failure, network drop, worker unreachable) come
// back as a consistent Error with a readable message instead of whatever
// raw exception the underlying fetch/URL implementation throws.
//
// An AbortController tied to a timer bounds the whole call. Without
// this, a hung waterfall on the worker side just rides out Vercel's
// maxDuration and takes the entire function down with it — callers
// like generateCoachingNarrative() never get their try/catch to run
// because the process is dead, not because the promise rejected.
async function workerPost(path: string, body: object, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${VALIDATED_WORKER_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-PitBoss-Key': getInternalKey(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Distinguish "we gave up waiting" from other transport failures
    // (bad URL, DNS, network) so callers/logs can tell a slow worker
    // apart from a broken one.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`PitBoss worker request to ${path} timed out after ${timeoutMs}ms`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`PitBoss worker request to ${path} failed before reaching the server: ${detail}`);
  } finally {
    clearTimeout(timer);
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
    // Worker returned a non-JSON 2xx body; surface clearly instead of
    // throwing an opaque JSON.parse error upstream.
    throw new Error(`PitBoss ${path} returned a non-JSON response body`);
  }
}

export const pbInfer = (opts: InferOptions) =>
  workerPost(
    '/infer',
    { mode: 'primary', max_tokens: 1024, temperature: 0.3, ...opts },
    opts.timeoutMs
  ) as Promise<InferResult>;

export const pbSteward = (
  incident:    Record<string, unknown>,
  regulations: RuleArticle[],
  league:      string,
  timeoutMs?:  number
): Promise<PbStewardResult | PbInferError> =>
  workerPost('/steward', { incident, regulations, league }, timeoutMs);

export const pbSetupFeedback = (
  feedbackText:    string,
  knownParamKeys:  string[],
  context:         Record<string, unknown>,
  league:          string,
  timeoutMs?:      number
): Promise<PbSetupFeedbackResult | PbInferError> =>
  workerPost('/setup-feedback', {
    feedback_text:     feedbackText,
    known_param_keys:  knownParamKeys,
    context,
    league,
  }, timeoutMs);

export const pbHealth = () =>
  fetch(`${VALIDATED_WORKER_URL}/health`, {
    headers: { 'X-PitBoss-Key': getInternalKey() },
  }).then((r) => r.json());
