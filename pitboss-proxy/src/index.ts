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

// ---------------------------------------------------------------------
// Checkin countdown cron — added for the live digital countdown / lights
// re-render feature. Duplicated from src/lib/pitboss/checkin-embed.ts
// (Next.js app) — Workers can't resolve that package's path aliases,
// and these are pure functions with zero deps, so duplication beats a
// fragile cross-package import. If the source functions change, update
// here too.
// ---------------------------------------------------------------------

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

  return `⏱️ **${pad(hours)}:${pad(minutes)}:${pad(seconds)}**`;
}

// Rebuilds just the description block's countdown/lights lines, given
// the fields already present on a posted embed. We PATCH description
// only — fields (status lists) are untouched by the cron, since those
// only change via button clicks, not time passing.
function refreshCountdownDescription(description: string, raceTimeIso: string): string {
  const lines = description.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("⏰ **Start:**"));
  if (startIdx === -1) return description; // no countdown block present, leave as-is

  // Everything from the "—————" separator right before "⏰ Start" onward
  // is the countdown block (separator, start line, lights, digital).
  const preludeEnd = startIdx > 0 && lines[startIdx - 1] === "—————" ? startIdx - 1 : startIdx;
  const head = lines.slice(0, preludeEnd);

  const unix = Math.floor(new Date(raceTimeIso).getTime() / 1000);
  const rebuilt = [
    "—————",
    `⏰ **Start:** <t:${unix}:F>  (<t:${unix}:R>)`,
    raceLights(raceTimeIso),
  ];
  const digital = formatDigitalCountdown(raceTimeIso);
  if (digital) rebuilt.push(digital);

  return [...head, ...rebuilt].join("\n");
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function fetchActiveCheckinPosts(env: any) {
  // Active window: race_time between now and 90 minutes out. Anything
  // further out doesn't need per-minute refresh; anything with
  // race_time already passed gets one final LIGHTS OUT patch below,
  // then naturally drops out of this window on the next run.
  const now = new Date();
  const soon = new Date(now.getTime() + 90 * 60 * 1000);
  const url = `${env.SUPABASE_URL}/rest/v1/round_checkin_posts` +
    `?select=id,discord_channel_id,discord_message_id,race_time,description_frozen` +
    `&race_time=gte.${now.toISOString()}` +
    `&race_time=lte.${soon.toISOString()}` +
    `&discord_message_id=not.is.null` +
    `&description_frozen=is.false`;

  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept-Profile": "pitboss",
    },
  });
  if (!res.ok) {
    console.error("[checkin-countdown] supabase fetch failed:", res.status, await res.text());
    return [];
  }
  return await res.json();
}

async function markPostFrozen(postId: string, env: any) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/round_checkin_posts?id=eq.${postId}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Profile": "pitboss",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ description_frozen: true }),
  });
}

async function handleCheckinCountdownTick(env: any) {
  const posts = await fetchActiveCheckinPosts(env);
  if (posts.length === 0) return { checked: 0, patched: 0 };

  const token = env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[checkin-countdown] PITBOSS_DISCORD_BOT_TOKEN not set — skipping tick.");
    return { checked: posts.length, patched: 0, error: "no_bot_token" };
  }

  let patched = 0;
  for (const post of posts) {
    try {
      const msgRes = await fetch(
        `${DISCORD_API_BASE}/channels/${post.discord_channel_id}/messages/${post.discord_message_id}`,
        { headers: { Authorization: `Bot ${token}` } }
      );
      if (!msgRes.ok) {
        console.error(`[checkin-countdown] fetch message failed for post ${post.id}:`, msgRes.status);
        continue;
      }
      const message = await msgRes.json();
      const embed = message.embeds?.[0];
      if (!embed) continue;

      const newDescription = refreshCountdownDescription(embed.description ?? "", post.race_time);
      const patchRes = await fetch(
        `${DISCORD_API_BASE}/channels/${post.discord_channel_id}/messages/${post.discord_message_id}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [{ ...embed, description: newDescription }] }),
        }
      );
      if (!patchRes.ok) {
        console.error(`[checkin-countdown] patch failed for post ${post.id}:`, patchRes.status, await patchRes.text());
        continue;
      }
      patched++;

      // race_time has passed as of this tick — one last LIGHTS OUT
      // patch just went out above; freeze so future ticks skip it.
      if (new Date(post.race_time).getTime() - Date.now() <= 0) {
        await markPostFrozen(post.id, env);
      }
    } catch (err) {
      console.error(`[checkin-countdown] tick failed for post ${post.id}:`, err);
      continue;
    }
  }
  return { checked: posts.length, patched };
}

// ... describeEvidenceImages, handleEspnRelay, handleInfer, handleSteward,
// handleSetupFeedback, handleHealth, and the default export fetch handler
// are UNCHANGED from what's currently deployed — only MODELS changed
// above, and the checkin-countdown block + scheduled() export below
// are new.

export default {
  // fetch(request, env, ctx) — UNCHANGED, existing handler stays exactly
  // as currently deployed.

  async scheduled(event: ScheduledEvent, env: any, ctx: ExecutionContext) {
    ctx.waitUntil(
      handleCheckinCountdownTick(env).then((result) => {
        console.log("[checkin-countdown] tick result:", JSON.stringify(result));
      })
    );
  },
};
