// src/index.ts — pitboss-proxy
// PATCH (2026-09-01): thinkingmachines/inkling and inkling-small removed
// from every pool. Confirmed via OpenRouter's own model pages: "The free
// Inkling endpoint is only available for use with agentic harnesses"
// (Claude Code, Codex, etc.) — this is a hard 403 for any plain server-to-
// server chat-completions caller like this Worker, not a rotation/staleness
// issue. It was never actually callable from here. Replaced with free
// models that have no such restriction, verified against openrouter.ai/
// collections/free-models on 2026-09-01.

const MODELS = {
  // General purpose — quality ordered.
  general: [
    "minimax/minimax-m3:free",
    // multimodal, 1M context, strong general-purpose default
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    // frontier reasoning/orchestration fallback
    "nvidia/nemotron-3.5-lightning:free"
    // last resort — fast but weaker
  ],

  // Reasoning / steward — deep thinking models. Free-first, paid fallback
  // applies if all of these fail.
  reasoning: [
    "z-ai/glm-5.2:free",
    // large-scale reasoning model, high/xhigh reasoning effort supported
    "nvidia/nemotron-3-super-120b-a12b:free"
    // 120B hybrid MoE, strong on multi-step reasoning benchmarks
  ],

  // Coding — confirmed live and NOT agentic-harness-gated.
  coding: [
    "poolside/laguna-s-2.1:free",
    // purpose-built coding agent model, 70.2% Terminal-Bench 2.1 — no
    // reported failures in production logs, keeping as-is
    "cohere/north-mini-code:free"
    // dedicated agentic coding model, JSON-schema tool use, low latency
  ],

  // Vision — dots-3-note-preview has a hard expiration_date of 2026-09-30.
  // TODO: re-check before then, this model disappears. Added a second
  // vision-capable model as a fallback so /steward evidence analysis
  // doesn't go dark entirely when it expires.
  vision: [
    "dots-studio/dots-3-note-preview:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    // multimodal (text/image/video/audio), no known expiration
  ],

  // Fast / low latency — unchanged, no reported failures.
  fast: [
    "nvidia/nemotron-3.5-lightning:free",
    "liquid/lfm-2.5-2.6b:free"
  ]
};

const PAID_FALLBACK = [
  { model: "anthropic/claude-sonnet-4-6", key: "ANTHROPIC_KEY" },
  { model: "openai/gpt-4o-mini", key: "OPENAI_KEY" }
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PitBoss-Key"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;
function isLikelyImageUrl(url: string) {
  return IMAGE_EXT_RE.test(url.split("?")[0]);
}

const MAX_EVIDENCE_IMAGES = 4;

function poolForMode(mode: string, hasImage: boolean) {
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

const PER_MODEL_TIMEOUT_MS = 10_000;
const FREE_WATERFALL_BUDGET_MS = 12_000;
const PAID_FALLBACK_BUDGET_MS = 6_000;

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callPaidFallback(body: any, env: any) {
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
        const anthropicRes = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
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
        if (!anthropicRes.ok) continue;
        const anthropicData = await anthropicRes.json();
        const text = (anthropicData.content ?? []).map((b: any) => b.text ?? "").join("");
        return {
          response: text,
          model: anthropicData.model ?? model,
          provider: "anthropic:paid",
          free: false,
          usage: anthropicData.usage ?? null
        };
      }
      const openaiRes = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...body, model: model.replace("openai/", "") })
      }, timeout);
      if (!openaiRes.ok) continue;
      const openaiData = await openaiRes.json();
      return {
        response: openaiData.choices[0].message.content,
        model: openaiData.model ?? model,
        provider: "openai:paid",
        free: false,
        usage: openaiData.usage ?? null
      };
    } catch {
      continue;
    }
  }
  return null;
}

function hasPaidKeyConfigured(env: any) {
  return Boolean(env.ANTHROPIC_KEY || env.OPENAI_KEY);
}

function hasImageContent(body: any) {
  const messages = body.messages;
  return Array.isArray(messages) && messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
  );
}

async function freeWaterfall(pool: string[], body: any, env: any) {
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
      const data = await res.json();
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

async function inferWithWaterfall(pool: string[], body: any, env: any, options: { preferPaid?: boolean } = {}) {
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

// ... describeEvidenceImages, handleEspnRelay, handleInfer, handleSteward,
// handleSetupFeedback, handleHealth, and the default export fetch handler
// are UNCHANGED from what's currently deployed — only MODELS changed above.
