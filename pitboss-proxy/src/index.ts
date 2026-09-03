// pitboss-proxy/src/index.ts — Cloudflare Worker
//
// PATCH (2026-09-01): thinkingmachines/inkling and inkling-small removed
// from every pool. Confirmed via OpenRouter's own model pages: "The free
// Inkling endpoint is only available for use with agentic harnesses"
// (Claude Code, Codex, etc.) — this is a hard 403 for any plain server-to-
// server chat-completions caller like this Worker, not a rotation/staleness
// issue. It was never actually callable from here. Replaced with free
// models that have no such restriction, verified against openrouter.ai/
// collections/free-models on 2026-09-01.
//
// RESTORED (2026-09-03): the previous deploy accidentally shipped ONLY the
// checkin-countdown cron + scheduled() handler — the entire fetch() router
// (infer/steward/setup-feedback/health/espn-relay) was dropped from
// production because it was left as a comment ("UNCHANGED from what's
// currently deployed") instead of the real code being merged in. This
// restores the full handler set alongside the cron addition.
//
// PATCH (2026-09-03): checkin-countdown cron split into two tiers.
// Imminent posts (race_time within 90 min) still patch every tick, same
// as before. Posts farther out (up to 48h) now also get patched, but
// only on every 5th tick (~every 5 min) instead of never — previously
// anything outside the 90-minute window was silently skipped forever,
// which is why a countdown for a race >90 min away only ever moved on a
// check-in button click (embed rebuild), never from the cron itself.

interface Env {
  OPENROUTER_API_KEY: string;
  PITBOSS_INTERNAL_KEY: string;
  ANTHROPIC_KEY?: string;
  OPENAI_KEY?: string;
  // Added for the checkin-countdown cron (scheduled handler only).
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PITBOSS_DISCORD_BOT_TOKEN?: string;
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

// ─── Model registry ────────────────────────────────────────────────────────
// Ordered by quality per task. All :free. Paid models only appear in
// PAID_FALLBACK. See PATCH (2026-09-01) note above.

const MODELS = {
  general: [
    "minimax/minimax-m3:free",
    // multimodal, 1M context, strong general-purpose default
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    // frontier reasoning/orchestration fallback
    "nvidia/nemotron-3.5-lightning:free"
    // last resort — fast but weaker
  ],

  reasoning: [
    "z-ai/glm-5.2:free",
    // large-scale reasoning model, high/xhigh reasoning effort supported
    "nvidia/nemotron-3-super-120b-a12b:free"
    // 120B hybrid MoE, strong on multi-step reasoning benchmarks
  ],

  coding: [
    "poolside/laguna-s-2.1:free",
    // purpose-built coding agent model, 70.2% Terminal-Bench 2.1 — no
    // reported failures in production logs, keeping as-is
    "cohere/north-mini-code:free"
    // dedicated agentic coding model, JSON-schema tool use, low latency
  ],

  // Vision — dots-3-note-preview has a hard expiration_date of 2026-09-30.
  // TODO: re-check before then, this model disappears.
  vision: [
    "dots-studio/dots-3-note-preview:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    // multimodal (text/image/video/audio), no known expiration
  ],

  fast: [
    "nvidia/nemotron-3.5-lightning:free",
    "liquid/lfm-2.5-2.6b:free"
  ]
};

// Paid fallback — hit when every free model in the pool fails or times out.
// Each entry names its OWN provider's native API (not routed through
// OpenRouter) and the env var holding that provider's key.
const PAID_FALLBACK = [
  { model: "anthropic/claude-sonnet-4-6", key: "ANTHROPIC_KEY" },
  { model: "openai/gpt-4o-mini", key: "OPENAI_KEY" }
];

// ─── CORS helpers ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PitBoss-Key"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

// ─── Evidence-image helpers ──────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

function isLikelyImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url.split("?")[0]);
}

// Evidence images add real latency/cost per request, and free vision
// models have modest limits — cap how many go in as image blocks.
const MAX_EVIDENCE_IMAGES = 4;

// ─── Mode → pool mapping ──────────────────────────────────────────────────────

function poolForMode(mode: string, hasImage: boolean): string[] {
  if (hasImage) return MODELS.vision;
  switch (mode) {
    case "reasoning":
    case "steward":
    case "certgen":
      return MODELS.reasoning;
    case "coding":
      return MODELS.coding;
    case "fast":
    case "quick":
      return MODELS.fast;
    default:
      return MODELS.general;
  }
}

// ─── Timeout helper ────────────────────────────────────────────────────────────
// Bounds how long any single model attempt can hang before the waterfall
// moves on. Shared phase budgets (below) additionally bound the whole
// pool, not just one model — worst case end-to-end ~18s, under the
// client-side timeout in pitboss-llm.ts.

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

function hasPaidKeyConfigured(env: any): boolean {
  return Boolean(env.ANTHROPIC_KEY || env.OPENAI_KEY);
}

function hasImageContent(body: any): boolean {
  const messages = body.messages;
  return Array.isArray(messages) && messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
  );
}

// ─── Paid fallback ───────────────────────────────────────────────────────────
// Tries each configured paid provider natively (not via OpenRouter) in
// order, skipping any provider whose key isn't set in env, and skipping
// Anthropic specifically when the request carries image content (that
// path isn't wired up for multimodal here). Returns null if none succeed.

async function callPaidFallback(body: any, env: any): Promise<InferResult | null> {
  const deadline = Date.now() + PAID_FALLBACK_BUDGET_MS;
  const skipAnthropic = hasImageContent(body);

  for (const { model, key } of PAID_FALLBACK) {
    const apiKey = env[key];
    if (!apiKey) continue;
    if (skipAnthropic && model.startsWith("anthropic/")) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = Math.min(PER_MODEL_TIMEOUT_MS, remaining);

    try {
      if (model.startsWith("anthropic/")) {
        const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: model.replace("anthropic/", ""),
            max_tokens: body.max_tokens ?? 1024,
            messages: body.messages
          })
        }, timeout);

        if (!res.ok) continue;
        const data: any = await res.json();
        const text = (data.content ?? []).map((b: any) => b.text ?? "").join("");
        return {
          response: text,
          model: data.model ?? model,
          provider: "anthropic:paid",
          free: false,
          usage: data.usage ?? null
        };
      }

      const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...body, model: model.replace("openai/", "") })
      }, timeout);

      if (!res.ok) continue;
      const data: any = await res.json();
      return {
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: "openai:paid",
        free: false,
        usage: data.usage ?? null
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Free waterfall ──────────────────────────────────────────────────────────

async function freeWaterfall(pool: string[], body: any, env: any): Promise<InferResult | InferError> {
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
      const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openrouterKey}`,
          "HTTP-Referer": "https://rise-os.app",
          "X-Title": "PitBoss Internal LLM"
        },
        body: JSON.stringify({ ...body, model })
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
        provider: "openrouter:free",
        free: true,
        usage: data.usage ?? null
      };
    } catch (err: any) {
      if (err && err.name === "AbortError") {
        errors.push(`${model}: timed out after ${timeout}ms`);
      } else {
        errors.push(`${model}: ${String(err)}`);
      }
      continue;
    }
  }
  return { error: "all_free_models_failed", tried: errors };
}

// ─── Core inference with waterfall ───────────────────────────────────────────
// Free models first, paid fallback only if every free model fails (unless
// options.preferPaid is set, which flips the order).

async function inferWithWaterfall(
  pool: string[],
  body: any,
  env: any,
  options: { preferPaid?: boolean } = {}
): Promise<InferResult | InferError> {
  if (options.preferPaid) {
    if (hasPaidKeyConfigured(env)) {
      const paidResult = await callPaidFallback(body, env);
      if (paidResult) return paidResult;
    }
    return await freeWaterfall(pool, body, env);
  }
  const freeResult = await freeWaterfall(pool, body, env);
  if (!("error" in freeResult)) return freeResult;
  if (hasPaidKeyConfigured(env)) {
    const paidResult = await callPaidFallback(body, env);
    if (paidResult) return paidResult;
  }
  return freeResult;
}

// ─── Image-description pass (used by /steward) ───────────────────────────────
// Pass 1: ask a vision model to describe what's visible in each image,
// purely factually — no verdict, no rule interpretation.

async function describeEvidenceImages(
  imageUrls: string[],
  incidentContext: string,
  env: Env
): Promise<{ description: string; model: string; usage: InferResult["usage"] } | null> {
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
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))
          ]
        }
      ],
      max_tokens: 700,
      temperature: 0.1
    },
    env
  );

  if ("error" in data) return null;

  return {
    description: data.response,
    model: data.model,
    usage: data.usage ?? null
  };
}

// ─── ESPN relay (used by rise-os's hbcu-rosters cron) ─────────────────────────
// rise-os's hbcu-rosters cron gets 403'd calling ESPN's undocumented
// site.api.espn.com directly from Vercel's serverless egress IPs — relaying
// through this Worker's egress gives it a different IP range to test
// against. Locked to a single allowed host so this can't become an open
// SSRF relay for arbitrary outbound requests.

const ESPN_RELAY_ALLOWED_HOST = "site.api.espn.com";

const ESPN_RELAY_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.espn.com/"
};

async function handleEspnRelay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return jsonResponse({ error: "Missing url parameter" }, 400);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonResponse({ error: "Invalid url parameter" }, 400);
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
        "Content-Type": res.headers.get("Content-Type") ?? "application/json",
        ...CORS_HEADERS
      }
    });
  } catch (err) {
    return jsonResponse({ error: "espn_relay_fetch_failed", message: String(err) }, 502);
  }
}

// ─── Route handlers ────────────────────────────────────────────────────────────

async function handleInfer(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const mode = body.mode ?? "primary";
  const hasImage = Array.isArray(body.messages) &&
    body.messages.some((m: any) =>
      Array.isArray(m.content) &&
      m.content.some((p: any) => p.type === "image_url")
    );

  const pool = poolForMode(mode, hasImage);
  const inferBody = {
    messages: body.messages ?? [
      ...(body.system ? [{ role: "system", content: body.system }] : []),
      ...(body.prompt ? [{ role: "user", content: body.prompt }] : [])
    ],
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature ?? 0.3
  };

  const data = await inferWithWaterfall(pool, inferBody, env);
  if ("error" in data) return jsonResponse(data, 503);
  return jsonResponse(data);
}

async function handleSteward(request: Request, env: Env): Promise<Response> {
  const { incident, regulations = [], league = "AWC" } = await request.json() as any;

  const regsBlock = regulations.length > 0
    ? regulations.map((r: any) => `Article ${r.article_number} — ${r.title}:\n${r.body}`).join("\n\n")
    : "No specific regulations provided. Apply standard racing conduct rules.";

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
      `${incident.incident_type} incident, lap ${incident.lap ?? "?"}`,
      env
    );
  }

  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON — no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }
Base your verdict on ALL evidence provided — the reporter's account, the accused driver's defense (if any), evidence links, the full ticket conversation transcript if included, and the image description if provided. The image description was produced by a separate vision pass and reflects only what is visibly observable — treat it as a factual account, not a verdict.`;

  const promptParts = [
    `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? "Unknown"} | LAP: ${incident.lap ?? "?"}`,
    `ACCUSED: ${incident.accused_username ?? "Unknown"}`,
    `REPORTER DESCRIPTION: ${incident.description}`
  ];

  if (reporterEvidence.length > 0) {
    promptParts.push(
      `REPORTER EVIDENCE LINKS:\n${reporterEvidence.map((e: EvidenceItem) => `- ${e.label ? `${e.label}: ` : ""}${e.url}`).join("\n")}`
    );
  }

  if (incident.accused_response) {
    promptParts.push(`ACCUSED DRIVER'S DEFENSE: ${incident.accused_response}`);
  }

  if (accusedEvidence.length > 0) {
    promptParts.push(
      `ACCUSED EVIDENCE LINKS:\n${accusedEvidence.map((e: EvidenceItem) => `- ${e.label ? `${e.label}: ` : ""}${e.url}`).join("\n")}`
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

  const prompt = promptParts.join("\n\n");

  const data = await inferWithWaterfall(
    MODELS.reasoning,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.1
    },
    env
  );

  if ("error" in data) return jsonResponse(data, 503);

  const imageAnalysisMeta = imageAnalysis
    ? { model: imageAnalysis.model, usage: imageAnalysis.usage, image_count: imageUrls.length }
    : null;

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const suggestion = JSON.parse(raw);
    return jsonResponse({
      ...data,
      league,
      suggestion,
      image_analysis: imageAnalysisMeta,
      disclaimer: "AI suggestion only. Human steward decision required."
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      suggestion: { verdict: "inconclusive", confidence: "low", parse_error: true, raw: data.response },
      image_analysis: imageAnalysisMeta,
      disclaimer: "AI suggestion only. Human steward decision required."
    });
  }
}

async function handleSetupFeedback(request: Request, env: Env): Promise<Response> {
  const { feedback_text, known_param_keys = [], context = {}, league = "AWC" } = await request.json() as any;

  if (!feedback_text || known_param_keys.length === 0) {
    return jsonResponse({ error: "feedback_text and known_param_keys are required" }, 400);
  }

  const paramKeysBlock = known_param_keys.map((k: string) => `- ${k}`).join("\n");

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
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.2
    },
    env
  );

  if ("error" in data) return jsonResponse(data, 503);

  const disclaimer = "AI-generated suggestion. Review before applying to setup.";

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed: any = JSON.parse(raw);

    const validKeys = new Set(known_param_keys);
    parsed.adjustments = (parsed.adjustments ?? []).filter((a: any) =>
      a && typeof a.param_key === "string" && validKeys.has(a.param_key) &&
      typeof a.delta === "number" &&
      ["low", "medium", "high"].includes(a.confidence)
    );

    return jsonResponse({
      ...data,
      league,
      adjustments: parsed.adjustments,
      summary: parsed.summary ?? "",
      disclaimer
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      adjustments: [],
      summary: "",
      raw: data.response,
      parse_error: true,
      disclaimer
    });
  }
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  const probes = await Promise.allSettled(
    Object.entries(MODELS).map(async ([pool, models]) => {
      const start = Date.now();
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`
        },
        body: JSON.stringify({
          model: models[0],
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 3
        })
      });
      return { pool, model: models[0], status: res.ok ? "ok" : res.status, latencyMs: Date.now() - start };
    })
  );

  return jsonResponse({
    status: "ok",
    source: "pitboss-proxy",
    pools: probes.map((p) => (p.status === "fulfilled" ? p.value : { error: String(p.reason) })),
    models: MODELS
  });
}

// ─── Checkin countdown cron ────────────────────────────────────────────────
// Duplicated from src/lib/pitboss/checkin-embed.ts (Next.js app) — Workers
// can't resolve that package's path aliases, and these are pure functions
// with zero deps, so duplication beats a fragile cross-package import. If
// the source functions change, update here too.

function raceLights(raceTimeIso: string | null): string {
  if (!raceTimeIso) return "";
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  const minsRemaining = msRemaining / 60000;

  if (minsRemaining <= 0) return "🟢🟢🟢🟢🟢  **LIGHTS OUT — GO!**";
  if (minsRemaining <= 5) return "🔴🔴🔴🔴🔴  **Formation lap — get ready**";
  if (minsRemaining <= 30) return "🔴🔴🔴⚫⚫  **Grid forming**";
  if (minsRemaining <= 60) return "🔴🔴⚫⚫⚫  **Pit lane opens soon**";
  return "🔴⚫⚫⚫⚫  **Session upcoming**";
}

function formatDigitalCountdown(raceTimeIso: string | null): string | null {
  if (!raceTimeIso) return null;
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  if (msRemaining <= 0) return null;

  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return `⏱ **${pad(hours)}:${pad(minutes)}:${pad(seconds)}**`;
}

function refreshCountdownDescription(description: string, raceTimeIso: string): string {
  const lines = description.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("⏰ **Start:**"));
  if (startIdx === -1) return description;

  const preludeEnd = startIdx > 0 && lines[startIdx - 1] === "—————" ? startIdx - 1 : startIdx;
  const head = lines.slice(0, preludeEnd);

  const unix = Math.floor(new Date(raceTimeIso).getTime() / 1000);
  const rebuilt = [
    "—————",
    `⏰ **Start:** <t:${unix}:F>  (<t:${unix}:R>)`,
    raceLights(raceTimeIso)
  ];
  const digital = formatDigitalCountdown(raceTimeIso);
  if (digital) rebuilt.push(digital);

  return [...head, ...rebuilt].join("\n");
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

interface CheckinPostRow {
  id: string;
  discord_channel_id: string;
  discord_message_id: string;
  race_time: string;
  description_frozen: boolean;
}

// PATCH (2026-09-03): split into two tiers instead of one 90-minute
// window. Previously, any post whose race_time was more than 90 minutes
// out was silently excluded from every tick, forever — the countdown for
// it only ever moved when a driver clicked a check-in button (which
// rebuilds the embed directly, bypassing this fetch entirely). Now
// anything within 48h gets picked up too, just less frequently.

const IMMINENT_WINDOW_MS = 90 * 60 * 1000; // every tick, same as before
const UPCOMING_WINDOW_MS = 48 * 60 * 60 * 1000; // every 5th tick only
const UPCOMING_TICK_INTERVAL_MIN = 5;

async function fetchCheckinPosts(env: any, fromMs: number, toMs: number): Promise<CheckinPostRow[]> {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const url = `${env.SUPABASE_URL}/rest/v1/round_checkin_posts` +
    `?select=id,discord_channel_id,discord_message_id,race_time,description_frozen` +
    `&race_time=gte.${from}` +
    `&race_time=lte.${to}` +
    `&discord_message_id=not.is.null` +
    `&description_frozen=is.false`;

  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept-Profile": "pitboss"
    }
  });
  if (!res.ok) {
    console.error("[checkin-countdown] supabase fetch failed:", res.status, await res.text());
    return [];
  }
  return await res.json();
}

/** Imminent tier: race_time within the next 90 minutes. Every tick. */
async function fetchImminentCheckinPosts(env: any): Promise<CheckinPostRow[]> {
  const now = Date.now();
  return fetchCheckinPosts(env, now, now + IMMINENT_WINDOW_MS);
}

/**
 * Upcoming tier: race_time between 90 minutes and 48 hours out. Only
 * fetched on every 5th tick (~every 5 min) — a race that's hours away
 * doesn't need second-by-second freshness, just visible movement over
 * time. Keeps Discord edit + Supabase read volume down for leagues
 * running many simultaneous division check-ins.
 */
async function fetchUpcomingCheckinPosts(env: any): Promise<CheckinPostRow[]> {
  const now = Date.now();
  return fetchCheckinPosts(env, now + IMMINENT_WINDOW_MS, now + UPCOMING_WINDOW_MS);
}

/**
 * Whether this tick should also process the upcoming tier. Gated on
 * wall-clock minute rather than an in-memory counter, since a Worker's
 * scheduled() invocation doesn't persist state between ticks — using
 * the minute-of-hour keeps this deterministic across restarts/redeploys
 * instead of drifting based on when the Worker happened to last run.
 */
function isUpcomingTierTick(scheduledTimeMs: number): boolean {
  const minute = new Date(scheduledTimeMs).getUTCMinutes();
  return minute % UPCOMING_TICK_INTERVAL_MIN === 0;
}

async function markPostFrozen(postId: string, env: any) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/round_checkin_posts?id=eq.${postId}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Profile": "pitboss",
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ description_frozen: true })
  });
}

async function patchCheckinPost(post: CheckinPostRow, token: string, env: any): Promise<boolean> {
  const msgRes = await fetch(
    `${DISCORD_API_BASE}/channels/${post.discord_channel_id}/messages/${post.discord_message_id}`,
    { headers: { Authorization: `Bot ${token}` } }
  );
  if (!msgRes.ok) {
    console.error(`[checkin-countdown] fetch message failed for post ${post.id}:`, msgRes.status);
    return false;
  }
  const message: any = await msgRes.json();
  const embed = message.embeds?.[0];
  if (!embed) return false;

  const newDescription = refreshCountdownDescription(embed.description ?? "", post.race_time);
  const patchRes = await fetch(
    `${DISCORD_API_BASE}/channels/${post.discord_channel_id}/messages/${post.discord_message_id}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [{ ...embed, description: newDescription }] })
    }
  );
  if (!patchRes.ok) {
    console.error(`[checkin-countdown] patch failed for post ${post.id}:`, patchRes.status, await patchRes.text());
    return false;
  }

  if (new Date(post.race_time).getTime() - Date.now() <= 0) {
    await markPostFrozen(post.id, env);
  }
  return true;
}

async function handleCheckinCountdownTick(env: any, scheduledTimeMs: number = Date.now()) {
  const token = env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[checkin-countdown] PITBOSS_DISCORD_BOT_TOKEN not set — skipping tick.");
    return { checked: 0, patched: 0, error: "no_bot_token" };
  }

  const runUpcomingTier = isUpcomingTierTick(scheduledTimeMs);

  const [imminentPosts, upcomingPosts] = await Promise.all([
    fetchImminentCheckinPosts(env),
    runUpcomingTier ? fetchUpcomingCheckinPosts(env) : Promise.resolve([] as CheckinPostRow[])
  ]);

  const posts = [...imminentPosts, ...upcomingPosts];
  if (posts.length === 0) {
    return { checked: 0, patched: 0, ranUpcomingTier: runUpcomingTier };
  }

  let patched = 0;
  for (const post of posts) {
    try {
      const ok = await patchCheckinPost(post, token, env);
      if (ok) patched++;
    } catch (err) {
      console.error(`[checkin-countdown] tick failed for post ${post.id}:`, err);
      continue;
    }
  }

  return {
    checked: posts.length,
    patched,
    imminent: imminentPosts.length,
    upcoming: upcomingPosts.length,
    ranUpcomingTier: runUpcomingTier
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const key = request.headers.get("X-PitBoss-Key");
    if (key !== env.PITBOSS_INTERNAL_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    try {
      if (pathname === "/infer" && method === "POST") {
        return await handleInfer(request, env);
      }
      if (pathname === "/steward" && method === "POST") {
        return await handleSteward(request, env);
      }
      if (pathname === "/setup-feedback" && method === "POST") {
        return await handleSetupFeedback(request, env);
      }
      if (pathname === "/health" && method === "GET") {
        return await handleHealth(request, env);
      }
      if (pathname === "/espn-relay" && method === "GET") {
        return await handleEspnRelay(request, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: "internal_error", message: String(err) }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      handleCheckinCountdownTick(env, event.scheduledTime).then((result) => {
        console.log("[checkin-countdown] tick result:", JSON.stringify(result));
      })
    );
  }
};
