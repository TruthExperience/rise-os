// pitboss-proxy/index.ts  (Cloudflare Worker — TypeScript)
//
// CHANGES IN THIS PATCH:
//
// 1. `general` / `coding` / `fast` — the OLD free IDs (deepseek/*,
//    mistralai/*, meta-llama/llama-4-*, qwen/qwen3-235b-a22b:free) are ALL
//    DEAD. OpenRouter's free-tier catalog fully turned over; DeepSeek and
//    Mistral currently have zero $0 models at all. Replaced with IDs
//    confirmed live against OpenRouter's /v1/models on 2026-08-30. Still
//    free-waterfall-first, paid-fallback-last (unchanged ordering).
//
// 2. `vision` — same story, old IDs dead. Only ONE genuinely free
//    vision-capable model exists right now (dots-studio/dots-3-note-preview:free),
//    and it has a hard expiration_date of 2026-09-30. Given that fragility,
//    vision is now ALSO paid-first (Claude / GPT-4o-mini both handle images
//    natively), with the one free model as the safety net. Re-check before
//    Sept 30 — it disappears then.
//
// 3. UPDATE: reasoning / steward / setup-feedback / vision were briefly made
//    paid-first, then reverted back to free-first-then-paid-fallback for
//    everything, per Crystal. The `preferPaid` option on inferWithWaterfall
//    still exists (all call sites currently omit it / pass nothing, which
//    defaults to free-first) — flip a call site back to
//    `{ preferPaid: true }` if paid-first is wanted again later.
//
// 4. Paid-fallback skips Anthropic for any request carrying image content
//    (still relevant even free-first, since paid fallback still runs after
//    the free vision model fails) — the image blocks here are built in
//    OpenAI's `image_url` shape, which Anthropic's API rejects outright.
//    Falls straight to GPT-4o-mini instead of a guaranteed-failing Claude
//    call. See hasImageContent() / callPaidFallback().
//
// NOTE: handleInfer's mode switch maps 'reasoning' | 'steward' | 'certgen' all
// to MODELS.reasoning (predates this patch — see poolForMode). All run
// free-first now, same as everything else.

interface Env {
  OPENROUTER_API_KEY: string;
  PITBOSS_INTERNAL_KEY: string;
  ANTHROPIC_KEY?: string;
  OPENAI_KEY?: string;
}

type EvidenceItem = { url: string; label?: string; source?: string };

type InferResult = {
  response: string;
  model: string;
  provider: string;
  free: boolean;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
};

type InferError = { error: string; tried?: string[] };

type InferOptions = {
  // ADDED — when true, inferWithWaterfall tries paid providers first via
  // callPaidFallback(), and only falls into the free waterfall pool if no
  // paid key is configured or every configured paid provider fails.
  preferPaid?: boolean;
};

// ─── Model registry ───────────────────────────────────────────────────────────

const MODELS = {

  // General purpose — quality ordered. Confirmed live against OpenRouter's
  // /v1/models on 2026-08-30. Old catalog (deepseek/*, mistral/*, llama-4/*)
  // is gone entirely — this whole tier turned over.
  general: [
    'thinkingmachines/inkling:free',        // 41B active/975B total, best free generalist available
    'thinkingmachines/inkling-small:free',  // weaker/faster sibling, fallback
    'nvidia/nemotron-3.5-lightning:free',   // last resort — fast but noticeably weaker (intelligence_index 23.6)
  ],

  // Reasoning / steward — deep thinking models. Free-first, paid fallback
  // applies if all of these fail. These IDs were also all dead (confirmed
  // live 2026-08-30) — worth catching regardless of ordering, since a
  // free pool full of 404s just means every request pays for a paid call
  // it didn't need to. Reusing the same picks as `general`: inkling's
  // description explicitly covers "general-purpose reasoning" and it
  // supports JSON-via-system-prompt fine (no response_format/
  // structured_outputs param, but this code only ever asks for JSON in
  // the prompt and parses manually anyway).
  reasoning: [
    'thinkingmachines/inkling:free',
    'thinkingmachines/inkling-small:free',
  ],

  // Coding — confirmed live 2026-08-30.
  coding: [
    'poolside/laguna-s-2.1:free',      // purpose-built coding agent model, 70.2% Terminal-Bench 2.1
    'thinkingmachines/inkling:free',   // not coding-specialized but solid fallback (coding_index 52.1)
  ],

  // Vision — the previous IDs here were all dead (confirmed against live
  // OpenRouter catalog 2026-08-30), meaning evidence-photo analysis in
  // /steward was silently failing before ever reaching paid fallback.
  // Only one genuinely free vision-capable model exists right now, and it
  // has a hard expiration_date of 2026-09-30 — not something to depend on
  // long-term. Free-first (paid fallback still applies after it fails).
  // TODO(Crystal): re-check before 2026-09-30, this model disappears then.
  vision: [
    'dots-studio/dots-3-note-preview:free',
  ],

  // Fast / low latency — confirmed live 2026-08-30.
  fast: [
    'nvidia/nemotron-3.5-lightning:free', // built specifically for high-throughput agentic workloads
    'liquid/lfm-2.5-2.6b:free',           // smaller/faster still; Liquid's own docs say avoid for agentic coding — fine here, this pool isn't coding
    'thinkingmachines/inkling-small:free',
  ],

};

const PAID_FALLBACK = [
  { model: 'anthropic/claude-sonnet-4-6', key: 'ANTHROPIC_KEY' },
  { model: 'openai/gpt-4o-mini',          key: 'OPENAI_KEY'    },
];

// ─── CORS helpers ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PitBoss-Key',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Evidence-image helpers ───────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

function isLikelyImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url.split('?')[0]);
}

const MAX_EVIDENCE_IMAGES = 4;

// ─── Mode → pool mapping ──────────────────────────────────────────────────────

function poolForMode(mode: string, hasImage: boolean): string[] {
  if (hasImage) return MODELS.vision;
  switch (mode) {
    case 'reasoning':
    case 'steward':
    case 'certgen':   return MODELS.reasoning;
    case 'coding':    return MODELS.coding;
    case 'fast':
    case 'quick':     return MODELS.fast;
    default:          return MODELS.general;
  }
}

// preferPaid still exists as an option on inferWithWaterfall (see below) —
// no call site currently sets it to true. Everything runs free-first,
// paid-fallback-last. Flip a call site back to { preferPaid: true } if
// that route needs to prefer paid again.

// ─── Timeout helper ────────────────────────────────────────────────────────────

const PER_MODEL_TIMEOUT_MS = 10_000;
const FREE_WATERFALL_BUDGET_MS = 12_000;
const PAID_FALLBACK_BUDGET_MS = 6_000;

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Paid fallback ─────────────────────────────────────────────────────────────
// Unchanged logic — tries each configured paid provider natively, in order,
// skipping any whose key isn't set. Returns null if none succeed (including
// the case where NO key is set at all — callers must check that separately
// if they need to distinguish "no key configured" from "key configured but
// call failed", which inferWithWaterfall does via hasPaidKeyConfigured()).
async function callPaidFallback(body: Record<string, unknown>, env: Env): Promise<InferResult | null> {
  const deadline = Date.now() + PAID_FALLBACK_BUDGET_MS;
  const skipAnthropic = hasImageContent(body); // ADDED

  for (const { model, key } of PAID_FALLBACK) {
    const apiKey = env[key];
    if (!apiKey) continue;
    if (skipAnthropic && model.startsWith('anthropic/')) continue; // ADDED

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const timeout = Math.min(PER_MODEL_TIMEOUT_MS, remaining);

    try {
      if (model.startsWith('anthropic/')) {
        const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: model.replace('anthropic/', ''),
            max_tokens: body.max_tokens ?? 1024,
            messages: body.messages,
          }),
        }, timeout);

        if (!res.ok) continue;
        const data: any = await res.json();
        const text = (data.content ?? []).map((b: any) => b.text ?? '').join('');
        return {
          response: text,
          model: data.model ?? model,
          provider: 'anthropic:paid',
          free: false,
          usage: data.usage ?? null,
        };
      }

      const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...body, model: model.replace('openai/', '') }),
      }, timeout);

      if (!res.ok) continue;
      const data: any = await res.json();
      return {
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: 'openai:paid',
        free: false,
        usage: data.usage ?? null,
      };

    } catch {
      continue;
    }
  }
  return null;
}

// ADDED — lets callers distinguish "no paid key exists at all" from "a paid
// key exists but the call failed", since preferPaid's safety-net condition
// is "no key configured OR every provider failed", and the second half is
// already what callPaidFallback returning null covers.
function hasPaidKeyConfigured(env: Env): boolean {
  return Boolean(env.ANTHROPIC_KEY || env.OPENAI_KEY);
}

// ADDED — image content in this file is always built OpenAI-style
// ({ type: 'image_url', image_url: { url } }), since it was originally
// written only for OpenRouter's OpenAI-compatible endpoint. Anthropic's
// /v1/messages API expects a different shape ({ type: 'image',
// source: {...} }) and will reject the OpenAI shape outright. Now that
// vision can hit callPaidFallback directly (paid-first), skip Anthropic
// for any request carrying image content rather than sending a request
// guaranteed to fail — the loop falls straight through to OpenAI, which
// does accept this shape natively.
function hasImageContent(body: Record<string, unknown>): boolean {
  const messages = body.messages as any[] | undefined;
  return Array.isArray(messages) && messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url')
  );
}

// ─── Free waterfall (pool loop only, no paid fallback) ────────────────────────
// EXTRACTED from the old inferWithWaterfall — this is just the free-model
// loop over `pool`, budgeted the same way as before. It does NOT call
// callPaidFallback itself; both call orders (free-first-then-paid, and
// paid-first-then-free-safety-net) are now composed by inferWithWaterfall.
async function freeWaterfall(
  pool: string[],
  body: Record<string, unknown>,
  env: Env
): Promise<InferResult | InferError> {
  const openrouterKey = env.OPENROUTER_API_KEY;
  const errors: string[] = [];
  const deadline = Date.now() + FREE_WATERFALL_BUDGET_MS;

  for (const model of pool) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      errors.push(`${model}: skipped, free-waterfall budget exhausted`);
      break;
    }
    const timeout = Math.min(PER_MODEL_TIMEOUT_MS, remaining);

    try {
      const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openrouterKey}`,
          'HTTP-Referer': 'https://rise-os.app',
          'X-Title': 'PitBoss Internal LLM',
        },
        body: JSON.stringify({ ...body, model }),
      }, timeout);

      if (res.status === 429 || res.status === 503) {
        errors.push(`${model}: rate limited`);
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        errors.push(`${model}: ${res.status} ${err.slice(0, 100)}`);
        continue;
      }

      const data: any = await res.json();
      return {
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: 'openrouter:free',
        free: true,
        usage: data.usage ?? null,
      };

    } catch (err: any) {
      if (err && err.name === 'AbortError') {
        errors.push(`${model}: timed out after ${timeout}ms`);
      } else {
        errors.push(`${model}: ${String(err)}`);
      }
      continue;
    }
  }

  return { error: 'all_free_models_failed', tried: errors };
}

// ─── Core inference with waterfall ───────────────────────────────────────────
// Two orderings, selected by options.preferPaid:
//
//  preferPaid=false (default — general/coding/fast/vision):
//    free pool waterfall -> if all fail, paid fallback -> if that also
//    fails, return the free-pool error.
//
//  preferPaid=true (reasoning/steward/setup-feedback):
//    if a paid key is configured: try paid fallback first; if it succeeds,
//    return immediately.
//    if no paid key is configured, OR paid fallback returns null (every
//    configured provider failed): fall into the free pool waterfall as a
//    safety net; if that also fails, return the free-pool error.
async function inferWithWaterfall(
  pool: string[],
  body: Record<string, unknown>,
  env: Env,
  options: InferOptions = {}
): Promise<InferResult | InferError> {
  if (options.preferPaid) {
    if (hasPaidKeyConfigured(env)) {
      const paidResult = await callPaidFallback(body, env);
      if (paidResult) return paidResult;
      // every configured paid provider failed — drop to free safety net
    }
    // no paid key configured at all — drop to free safety net
    return await freeWaterfall(pool, body, env);
  }

  // Default ordering — free first, paid last.
  const freeResult = await freeWaterfall(pool, body, env);
  if (!('error' in freeResult)) return freeResult;

  if (hasPaidKeyConfigured(env)) {
    const paidResult = await callPaidFallback(body, env);
    if (paidResult) return paidResult;
  }

  return freeResult;
}

// ─── Image-description pass (used by /steward) ───────────────────────────────
// CHANGED — vision is now ALSO paid-first, same reasoning as
// reasoning/steward/setup-feedback: the free vision pool is down to a
// single model with a hard expiration date, so treating it as the
// primary path is risky. Paid providers (Claude, GPT-4o-mini) both
// handle images natively, so this is a safe default with the free
// model as the safety net if no paid key is configured or paid fails.
async function describeEvidenceImages(
  imageUrls: string[],
  incidentContext: string,
  env: Env
): Promise<{ description: string; model: string; usage: InferResult['usage'] } | null> {
  const system = `You are a factual image-description assistant for motorsport incident evidence.
Describe ONLY what is visibly happening in the image(s) — car positions, contact, track position, timing/HUD overlays if visible, any visible damage.
Do NOT render a verdict, cite rules, or speculate about intent. Stick to what's observable.
If an image fails to load or is unrelated to racing, say so plainly instead of guessing.`;

  const prompt = `INCIDENT CONTEXT (for reference only, not for you to judge): ${incidentContext}

Describe what's visible in the attached image(s), in order.`;

  const data = await inferWithWaterfall(
    MODELS.vision,
    {
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      max_tokens: 700,
      temperature: 0.1,
    },
    env
    // Back to free-first, per Crystal.
  );

  if ('error' in data) return null;

  return {
    description: data.response,
    model: data.model,
    usage: data.usage ?? null,
  };
}

// ─── ESPN relay (used by rise-os's hbcu-rosters cron) ─────────────────────────

const ESPN_RELAY_ALLOWED_HOST = 'site.api.espn.com';

const ESPN_RELAY_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.espn.com/',
};

async function handleEspnRelay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return jsonResponse({ error: 'Missing url parameter' }, 400);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonResponse({ error: 'Invalid url parameter' }, 400);
  }

  if (targetUrl.hostname !== ESPN_RELAY_ALLOWED_HOST) {
    return jsonResponse({ error: `Relay only permits ${ESPN_RELAY_ALLOWED_HOST}` }, 400);
  }

  try {
    const res = await fetchWithTimeout(
      targetUrl.toString(),
      { headers: ESPN_RELAY_HEADERS },
      PER_MODEL_TIMEOUT_MS
    );
    const bodyText = await res.text();
    return new Response(bodyText, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: 'espn_relay_fetch_failed', message: String(err) }, 502);
  }
}

// ─── Route handlers ────────────────────────────────────────────────────────────

async function handleInfer(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const mode = body.mode ?? 'primary';
  const hasImage = Array.isArray(body.messages) &&
    body.messages.some((m: any) =>
      Array.isArray(m.content) &&
      m.content.some((p: any) => p.type === 'image_url')
    );

  const pool = poolForMode(mode, hasImage);
  // Back to free-first for everything, per Crystal — preferPaid still
  // exists as an option on inferWithWaterfall if this needs to flip again.
  const inferBody = {
    messages: body.messages ?? [
      ...(body.system ? [{ role: 'system', content: body.system }] : []),
      ...(body.prompt ? [{ role: 'user', content: body.prompt }] : []),
    ],
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature ?? 0.3,
  };

  const data = await inferWithWaterfall(pool, inferBody, env);
  if ('error' in data) return jsonResponse(data, 503);
  return jsonResponse(data);
}

async function handleSteward(request: Request, env: Env): Promise<Response> {
  const { incident, regulations = [], league = 'AWC' } = await request.json() as any;

  const regsBlock = regulations.length > 0
    ? regulations.map((r: any) => `Article ${r.article_number} — ${r.title}:\n${r.body}`).join('\n\n')
    : 'No specific regulations provided. Apply standard racing conduct rules.';

  const reporterEvidence: EvidenceItem[] = incident.reporter_evidence ?? [];
  const accusedEvidence: EvidenceItem[] = incident.accused_evidence ?? [];
  const allEvidence = [...reporterEvidence, ...accusedEvidence];
  const imageEvidence = allEvidence
    .filter((e) => isLikelyImageUrl(e.url))
    .slice(0, MAX_EVIDENCE_IMAGES);
  const imageUrls = imageEvidence.map((e) => e.url);

  let imageAnalysis = null;
  if (imageUrls.length > 0) {
    imageAnalysis = await describeEvidenceImages(
      imageUrls,
      `${incident.incident_type} incident, lap ${incident.lap ?? '?'}`,
      env
    );
  }

  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON — no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }
Base your verdict on ALL evidence provided — the reporter's account, the accused driver's defense (if any), evidence links, the full ticket conversation transcript if included, and the image description if provided. The image description was produced by a separate vision pass and reflects only what is visibly observable — treat it as a factual account, not a verdict.`;

  const promptParts = [
    `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? 'Unknown'} | LAP: ${incident.lap ?? '?'}`,
    `ACCUSED: ${incident.accused_username ?? 'Unknown'}`,
    `REPORTER DESCRIPTION: ${incident.description}`,
  ];

  if (reporterEvidence.length > 0) {
    promptParts.push(
      `REPORTER EVIDENCE LINKS:\n${reporterEvidence.map((e: EvidenceItem) => `- ${e.label ? `${e.label}: ` : ''}${e.url}`).join('\n')}`
    );
  }

  if (incident.accused_response) {
    promptParts.push(`ACCUSED DRIVER'S DEFENSE: ${incident.accused_response}`);
  }

  if (accusedEvidence.length > 0) {
    promptParts.push(
      `ACCUSED EVIDENCE LINKS:\n${accusedEvidence.map((e: EvidenceItem) => `- ${e.label ? `${e.label}: ` : ''}${e.url}`).join('\n')}`
    );
  }

  if (imageAnalysis) {
    promptParts.push(`IMAGE EVIDENCE DESCRIPTION (from vision pass):\n${imageAnalysis.description}`);
  } else if (imageUrls.length > 0) {
    promptParts.push(`Note: ${imageUrls.length} evidence image(s) were submitted but could not be analyzed (link may have expired or failed to load).`);
  }

  if (incident.ticket_transcript) {
    const transcript = String(incident.ticket_transcript).slice(0, 6000);
    promptParts.push(`FULL TICKET CONVERSATION TRANSCRIPT:\n${transcript}`);
  }

  promptParts.push(`REGULATIONS:\n${regsBlock}`);

  const prompt = promptParts.join('\n\n');

  const data = await inferWithWaterfall(
    MODELS.reasoning,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    },
    env
    // Back to free-first, per Crystal.
  );

  if ('error' in data) return jsonResponse(data, 503);

  const imageAnalysisMeta = imageAnalysis
    ? { model: imageAnalysis.model, usage: imageAnalysis.usage, image_count: imageUrls.length }
    : null;

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const suggestion = JSON.parse(raw);
    return jsonResponse({
      ...data,
      league,
      suggestion,
      image_analysis: imageAnalysisMeta,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      suggestion: { verdict: 'inconclusive', confidence: 'low', parse_error: true, raw: data.response },
      image_analysis: imageAnalysisMeta,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  }
}

async function handleSetupFeedback(request: Request, env: Env): Promise<Response> {
  const { feedback_text, known_param_keys = [], context = {}, league = 'AWC' } = await request.json() as any;

  if (!feedback_text || known_param_keys.length === 0) {
    return jsonResponse({ error: 'feedback_text and known_param_keys are required' }, 400);
  }

  const paramKeysBlock = known_param_keys.map((k: string) => `- ${k}`).join('\n');

  const system = `You are a race engineering assistant for ${league} that converts driver setup feedback into structured parameter adjustments.
Return ONLY valid JSON — no markdown, no preamble.
VALID PARAM KEYS (you may ONLY use keys from this list — never invent a key):
${paramKeysBlock}
Shape: { "adjustments": [ { "param_key": string, "delta": number, "confidence": "low"|"medium"|"high", "reasoning": string } ], "summary": string }
Rules: delta is signed (positive = increase, negative = decrease). If feedback doesn't map to any known param, omit it. If feedback is too vague, return an empty adjustments array and explain why in summary.`;

  const prompt = `CONTEXT: ${JSON.stringify(context)}
DRIVER FEEDBACK: "${feedback_text}"`;

  const data = await inferWithWaterfall(
    MODELS.reasoning,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    },
    env
    // Back to free-first, per Crystal.
  );

  if ('error' in data) return jsonResponse(data, 503);

  const disclaimer = 'AI-generated suggestion. Review before applying to setup.';

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed: any = JSON.parse(raw);

    const validKeys = new Set(known_param_keys);
    parsed.adjustments = (parsed.adjustments ?? []).filter((a: any) =>
      a && typeof a.param_key === 'string' && validKeys.has(a.param_key) &&
      typeof a.delta === 'number' &&
      ['low', 'medium', 'high'].includes(a.confidence)
    );

    return jsonResponse({
      ...data,
      league,
      adjustments: parsed.adjustments,
      summary: parsed.summary ?? '',
      disclaimer,
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      adjustments: [],
      summary: '',
      raw: data.response,
      parse_error: true,
      disclaimer,
    });
  }
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  const probes = await Promise.allSettled(
    Object.entries(MODELS).map(async ([pool, models]) => {
      const start = Date.now();
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: models[0],
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 3,
        }),
      });
      return { pool, model: models[0], status: res.ok ? 'ok' : res.status, latencyMs: Date.now() - start };
    })
  );

  return jsonResponse({
    status: 'ok',
    source: 'pitboss-proxy',
    pools: probes.map((p) => (p.status === 'fulfilled' ? p.value : { error: String(p.reason) })),
    models: MODELS,
  });
}

// ─── Router ─────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const key = request.headers.get('X-PitBoss-Key');
    if (key !== env.PITBOSS_INTERNAL_KEY) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    try {
      if (pathname === '/infer' && method === 'POST') {
        return await handleInfer(request, env);
      }
      if (pathname === '/steward' && method === 'POST') {
        return await handleSteward(request, env);
      }
      if (pathname === '/setup-feedback' && method === 'POST') {
        return await handleSetupFeedback(request, env);
      }
      if (pathname === '/health' && method === 'GET') {
        return await handleHealth(request, env);
      }
      if (pathname === '/espn-relay' && method === 'GET') {
        return await handleEspnRelay(request, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'internal_error', message: String(err) }, 500);
    }
  },
};
