var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var MODELS = {
  general: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3.5-lightning:free"
  ],
  reasoning: [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free"
  ],
  coding: [
    "poolside/laguna-s-2.1:free",
    "cohere/north-mini-code:free",
    "poolside/laguna-xs-2.1:free"
  ],
  vision: [
    "dots-studio/dots-3-note-preview:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-31b-it:free"
  ],
  // Video description pass (OpenRouter only: Groq has no video input).
  video: [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-31b-it:free"
  ],
  fast: [
    "nvidia/nemotron-3.5-lightning:free",
    "liquid/lfm-2.5-2.6b:free"
  ]
};
var PAID_FALLBACK = [
  { model: "anthropic/claude-sonnet-5-5", key: "ANTHROPIC_KEY" },
  { model: "openai/gpt-4o-mini", key: "OPENAI_KEY" }
];
var CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PitBoss-Key"
};
async function safeEqual(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
__name(safeEqual, "safeEqual");
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
__name(jsonResponse, "jsonResponse");
var IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;
function isLikelyImageUrl(url) {
  return IMAGE_EXT_RE.test(url.split("?")[0]);
}
__name(isLikelyImageUrl, "isLikelyImageUrl");
var MAX_EVIDENCE_IMAGES = 4;

// ---------------------------------------------------------------------------
// Video evidence: resolve a submitted link to a direct video URL, then describe.
// Resolution order (first success wins):
//   1. direct file link (.mp4/.webm/.mov/.m4v) -> used as is
//   2. page tags (og:video etc.) for sites that expose a file (Medal, Streamable...)
//   3. external resolver service (yt-dlp) if VIDEO_RESOLVER_URL + VIDEO_RESOLVER_KEY set
//   4. Twitch GQL (legacy best-effort; often blocked from datacenter IPs)
// ---------------------------------------------------------------------------
var VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
var MAX_EVIDENCE_VIDEOS = 2;
var VIDEO_PASS_BUDGET_MS = 12e3;
var PAGE_FETCH_TIMEOUT_MS = 4e3;
var RESOLVER_TIMEOUT_MS = 2e4;
var TWITCH_RESOLVE_TIMEOUT_MS = 4e3;
var TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
var TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
var PAGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
var KNOWN_VIDEO_HOST_RE = /(^|\.)(medal\.tv|streamable\.com|twitch\.tv|youtube\.com|youtu\.be|x\.com|twitter\.com|vimeo\.com|outplayed\.tv|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|reddit\.com|v\.redd\.it|dubz\.link|streamff\.com|streamin\.one)$/i;
var NO_SCRAPE_HOST_RE = /(^|\.)(twitch\.tv|youtube\.com|youtu\.be|x\.com|twitter\.com|instagram\.com|tiktok\.com|facebook\.com|fb\.watch)$/i;
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, "");
  } catch {
    return null;
  }
}
__name(hostOf, "hostOf");
function isDirectVideoUrl(url) {
  try {
    return VIDEO_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
__name(isDirectVideoUrl, "isDirectVideoUrl");
function twitchClipSlug(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "clips.twitch.tv" && parts[0] && parts[0] !== "embed") return parts[0];
  if (host === "twitch.tv") {
    const i = parts.indexOf("clip");
    if (i !== -1 && parts[i + 1]) return parts[i + 1];
  }
  return null;
}
__name(twitchClipSlug, "twitchClipSlug");
function isVideoEvidenceUrl(url) {
  if (isDirectVideoUrl(url)) return true;
  const host = hostOf(url);
  return Boolean(host && KNOWN_VIDEO_HOST_RE.test(host));
}
__name(isVideoEvidenceUrl, "isVideoEvidenceUrl");
function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/");
}
__name(decodeHtmlEntities, "decodeHtmlEntities");
async function scrapeVideoUrl(pageUrl, reasons) {
  try {
    const res = await fetchWithTimeout(pageUrl, {
      headers: { "User-Agent": PAGE_UA, "Accept": "text/html,application/xhtml+xml" },
      redirect: "follow"
    }, PAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      reasons.push(`page fetch ${res.status} for ${hostOf(pageUrl)}`);
      return null;
    }
    const html = (await res.text()).slice(0, 4e5);
    const wanted = ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"];
    const found = {};
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
      const val = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (key && val && wanted.includes(key) && !found[key]) found[key] = decodeHtmlEntities(val);
    }
    for (const key of wanted) {
      const candidate = found[key];
      if (!candidate) continue;
      try {
        const abs = new URL(candidate, pageUrl).toString();
        if (!/^https?:/i.test(abs)) continue;
        // Skip embed/player pages: the model needs a file, not an HTML player.
        if (isDirectVideoUrl(abs) || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(abs) || /video|clip|cdn/i.test(abs) && !/\/embed|\/player/i.test(abs)) return abs;
      } catch {
      }
    }
    reasons.push(`no direct video tag on ${hostOf(pageUrl)}`);
    return null;
  } catch (err) {
    reasons.push(`page scrape failed for ${hostOf(pageUrl)}: ${String(err)}`);
    return null;
  }
}
__name(scrapeVideoUrl, "scrapeVideoUrl");
async function callVideoResolver(url, env, reasons) {
  try {
    const base = String(env.VIDEO_RESOLVER_URL).replace(/\/+$/, "");
    const res = await fetchWithTimeout(`${base}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Resolver-Key": env.VIDEO_RESOLVER_KEY },
      body: JSON.stringify({ url })
    }, RESOLVER_TIMEOUT_MS);
    if (!res.ok) {
      reasons.push(`resolver http ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data?.ok && data.url) return data.url;
    reasons.push(`resolver: ${String(data?.error ?? "no url returned").slice(0, 200)}`);
    return null;
  } catch (err) {
    reasons.push(`resolver unreachable: ${String(err)}`);
    return null;
  }
}
__name(callVideoResolver, "callVideoResolver");
async function resolveTwitchClipUrl(slug, reasons) {
  try {
    const res = await fetchWithTimeout(TWITCH_GQL_URL, {
      method: "POST",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: 'query($slug: ID!){ clip(slug: $slug){ playbackAccessToken(params:{platform:"web",playerType:"site",playerBackend:"mediaplayer"}){ signature value } videoQualities{ frameRate quality sourceURL } } }',
        variables: { slug }
      })
    }, TWITCH_RESOLVE_TIMEOUT_MS);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error("[video] twitch gql failed:", res.status, body);
      reasons.push(`twitch gql http ${res.status}`);
      return null;
    }
    const json = await res.json();
    const clip = json?.data?.clip;
    const token = clip?.playbackAccessToken;
    const qualities = (clip?.videoQualities ?? []).filter((q) => q?.sourceURL);
    if (!token?.signature || !token?.value || qualities.length === 0) {
      console.error("[video] twitch gql returned no playable clip:", JSON.stringify(json).slice(0, 300));
      reasons.push("twitch gql returned no playable clip");
      return null;
    }
    qualities.sort((a, b) => Number(b.quality) - Number(a.quality));
    const pick = qualities.find((q) => Number(q.quality) <= 720) ?? qualities[qualities.length - 1];
    return `${pick.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
  } catch (err) {
    console.error("[video] twitch resolve threw:", String(err));
    reasons.push(`twitch gql error: ${String(err)}`);
    return null;
  }
}
__name(resolveTwitchClipUrl, "resolveTwitchClipUrl");
async function resolveVideoUrl(url, env, reasons) {
  if (isDirectVideoUrl(url)) return { url, via: "direct" };
  const host = hostOf(url);
  if (!host) {
    reasons.push("invalid url");
    return null;
  }
  if (!NO_SCRAPE_HOST_RE.test(host)) {
    const scraped = await scrapeVideoUrl(url, reasons);
    if (scraped) return { url: scraped, via: "page-tags" };
  }
  if (env.VIDEO_RESOLVER_URL && env.VIDEO_RESOLVER_KEY) {
    const viaResolver = await callVideoResolver(url, env, reasons);
    if (viaResolver) return { url: viaResolver, via: "resolver" };
  }
  const slug = twitchClipSlug(url);
  if (slug) {
    const viaTwitch = await resolveTwitchClipUrl(slug, reasons);
    if (viaTwitch) return { url: viaTwitch, via: "twitch-gql" };
  }
  return null;
}
__name(resolveVideoUrl, "resolveVideoUrl");
async function analyseVideoEvidence(evidence, incidentContext, env) {
  const seen = /* @__PURE__ */ new Set();
  const candidates = evidence.filter((e) => isVideoEvidenceUrl(e.url)).filter((e) => seen.has(e.url) ? false : (seen.add(e.url), true)).slice(0, MAX_EVIDENCE_VIDEOS);
  const submitted = candidates.length;
  const reasons = [];
  if (submitted === 0) return { submitted: 0, analysis: null, reasons };
  const results = await Promise.all(candidates.map((e) => resolveVideoUrl(e.url, env, reasons)));
  const resolved = results.filter(Boolean);
  console.log("[video] resolved:", JSON.stringify(results.map((r, i) => ({ src: hostOf(candidates[i].url), via: r?.via ?? null }))));
  if (resolved.length === 0) {
    console.error("[video] none resolved:", JSON.stringify(reasons));
    return { submitted, analysis: null, reasons };
  }
  const system = `You are a factual video-description assistant for motorsport incident evidence.
Describe ONLY what is visibly happening in the video(s), in time order: car positions, who is ahead or behind, the moment of contact or loss of control, how each car reacts, track position, any HUD or timing overlay, any visible damage.
Do NOT render a verdict, cite rules, or speculate about intent. Stick to what is observable.
If a video fails to play, is unrelated to racing, or you cannot see the incident, say so plainly instead of guessing.`;
  const prompt = `INCIDENT CONTEXT (for reference only, not for you to judge): ${incidentContext}

Describe what happens in the attached video(s), in order.`;
  const data = await freeWaterfall(
    MODELS.video,
    {
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...resolved.map((r) => ({ type: "video_url", video_url: { url: r.url } }))
          ]
        }
      ],
      max_tokens: 900,
      temperature: 0.1
    },
    env,
    VIDEO_PASS_BUDGET_MS
  );
  if ("error" in data) {
    console.error("[video] description pass failed:", JSON.stringify(data.tried ?? data.error));
    // Include each model's actual failure (timeout, rate limit, HTTP status) in the
    // reasons so /steward analyse can show WHY the video pass failed. The org prefix
    // and ":free" suffix are stripped from the model name to keep each entry short.
    // Limit raised from 72 to 160 so the provider's message is not cut off.
    const detail = (data.tried ?? [data.error]).slice(0, 2).map((t) => String(t).replace(/^[^/\s]+\//, "").replace(":free", "").slice(0, 160)).join(" | ");
    reasons.push(`video model pass failed: ${detail}`);
    return { submitted, analysis: null, reasons };
  }
  return {
    submitted,
    reasons,
    analysis: {
      description: data.response,
      model: data.model,
      usage: data.usage ?? null,
      video_count: resolved.length,
      via: resolved.map((r) => r.via)
    }
  };
}
__name(analyseVideoEvidence, "analyseVideoEvidence");
function poolForMode(mode, hasImage) {
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
__name(poolForMode, "poolForMode");
var PER_MODEL_TIMEOUT_MS = 1e4;
var FREE_WATERFALL_BUDGET_MS = 1e4;
var GROQ_BUDGET_MS = 5e3;
var PAID_FALLBACK_BUDGET_MS = 6e3;
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
function hasPaidKeyConfigured(env) {
  return Boolean(env.ANTHROPIC_KEY || env.OPENAI_KEY);
}
__name(hasPaidKeyConfigured, "hasPaidKeyConfigured");
function hasImageContent(body) {
  const messages = body.messages;
  return Array.isArray(messages) && messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
  );
}
__name(hasImageContent, "hasImageContent");
function toAnthropicPayload(messages) {
  const systemParts = [];
  const out = [];
  for (const m of messages ?? []) {
    if (m.role === "system") {
      systemParts.push(
        typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("")
      );
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = [];
    for (const p of m.content ?? []) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text ?? "" });
      } else if (p.type === "image_url") {
        const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
        if (!url) continue;
        const dataMatch = /^data:([^;]+);base64,(.+)$/s.exec(url);
        parts.push(
          dataMatch ? { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } } : { type: "image", source: { type: "url", url } }
        );
      }
    }
    out.push({ role: m.role, content: parts });
  }
  return systemParts.length ? { system: systemParts.join("\n\n"), messages: out } : { messages: out };
}
__name(toAnthropicPayload, "toAnthropicPayload");
async function callPaidFallback(body, env) {
  const deadline = Date.now() + PAID_FALLBACK_BUDGET_MS;
  for (const { model, key } of PAID_FALLBACK) {
    const apiKey = env[key];
    if (!apiKey) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = Math.min(PER_MODEL_TIMEOUT_MS, remaining);
    try {
      if (model.startsWith("anthropic/")) {
        const res2 = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: model.replace("anthropic/", ""),
            max_tokens: body.max_tokens ?? 1024,
            ...toAnthropicPayload(body.messages)
          })
        }, timeout);
        if (!res2.ok) {
          console.error(`[paid-fallback] ${model} failed:`, res2.status, (await res2.text()).slice(0, 200));
          continue;
        }
        const data2 = await res2.json();
        const text = (data2.content ?? []).map((b) => b.text ?? "").join("");
        return {
          response: text,
          model: data2.model ?? model,
          provider: "anthropic:paid",
          free: false,
          usage: data2.usage ?? null
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
      if (!res.ok) {
        console.error(`[paid-fallback] ${model} failed:`, res.status, (await res.text()).slice(0, 200));
        continue;
      }
      const data = await res.json();
      return {
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: "openai:paid",
        free: false,
        usage: data.usage ?? null
      };
    } catch (err) {
      console.error(`[paid-fallback] ${model} threw:`, String(err));
      continue;
    }
  }
  return null;
}
__name(callPaidFallback, "callPaidFallback");
var LIVE_TTL_MS = 60 * 60 * 1e3;
var LIVE_FETCH_TIMEOUT_MS = 3e3;
var EXPIRY_GUARD_MS = 48 * 60 * 60 * 1e3;
var MIN_LIVE_MODELS = 5;
var MIN_POOL_SIZE = 2;
var MAX_BACKFILL = 2;
var BACKFILL_EXCLUDE = /inkling|content-safety|guard|lyria|tts|embed|^openrouter\/|^stealth\//i;
var liveCache = null;
async function getLiveFreeModels() {
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.models;
  try {
    const res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/models",
      { headers: { "Accept": "application/json" } },
      LIVE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return liveCache?.models ?? null;
    const json = await res.json();
    const out = /* @__PURE__ */ new Map();
    for (const m of json?.data ?? []) {
      if (!m?.id) continue;
      const free = Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;
      if (!free) continue;
      const outputs = m.architecture?.output_modalities ?? ["text"];
      if (!outputs.includes("text")) continue;
      if (m.expiration_date) {
        const exp = Date.parse(m.expiration_date);
        if (!Number.isNaN(exp) && exp - Date.now() < EXPIRY_GUARD_MS) continue;
      }
      const inputs = m.architecture?.input_modalities ?? ["text"];
      out.set(m.id, {
        id: m.id,
        image: inputs.includes("image"),
        ctx: Number(m.context_length) || 0
      });
    }
    if (out.size < MIN_LIVE_MODELS) return liveCache?.models ?? null;
    liveCache = { at: Date.now(), models: out };
    return out;
  } catch {
    return liveCache?.models ?? null;
  }
}
__name(getLiveFreeModels, "getLiveFreeModels");
async function reconcilePool(pool, needImage) {
  const live = await getLiveFreeModels();
  if (!live) return pool;
  const kept = pool.filter((id) => live.has(id));
  if (kept.length < MIN_POOL_SIZE) {
    const extras = [...live.values()].filter((m) => !kept.includes(m.id)).filter((m) => !BACKFILL_EXCLUDE.test(m.id)).filter((m) => !needImage || m.image).sort((a, b) => b.ctx - a.ctx).slice(0, MAX_BACKFILL).map((m) => m.id);
    kept.push(...extras);
  }
  return kept.length > 0 ? kept : pool;
}
__name(reconcilePool, "reconcilePool");
async function freeWaterfall(pool, body, env, budgetMs = FREE_WATERFALL_BUDGET_MS) {
  const openrouterKey = env.OPENROUTER_API_KEY;
  const errors = [];
  pool = await reconcilePool(pool, hasImageContent(body));
  const deadline = Date.now() + budgetMs;
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
        // Limit raised from 100 to 300 so the provider's full message is kept.
        errors.push(`${model}: ${res.status} ${err.slice(0, 300)}`);
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
    } catch (err) {
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
__name(freeWaterfall, "freeWaterfall");
var GROQ_MODELS = {
  general: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  reasoning: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  coding: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  vision: ["meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3.6-27b"],
  fast: ["llama-3.1-8b-instant", "openai/gpt-oss-20b"]
};
var groqLiveCache = null;
async function getLiveGroqIds(apiKey) {
  if (groqLiveCache && Date.now() - groqLiveCache.at < LIVE_TTL_MS) return groqLiveCache.ids;
  try {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { "Authorization": `Bearer ${apiKey}` } },
      LIVE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return groqLiveCache?.ids ?? null;
    const json = await res.json();
    const ids = new Set((json?.data ?? []).map((m) => m.id));
    if (ids.size < 3) return groqLiveCache?.ids ?? null;
    groqLiveCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return groqLiveCache?.ids ?? null;
  }
}
__name(getLiveGroqIds, "getLiveGroqIds");
function groqPoolFor(pool, hasImage) {
  if (hasImage) return GROQ_MODELS.vision;
  for (const key of Object.keys(MODELS)) {
    if (MODELS[key] === pool) return GROQ_MODELS[key];
  }
  return GROQ_MODELS.general;
}
__name(groqPoolFor, "groqPoolFor");
async function groqWaterfall(pool, body, env) {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return { error: "groq_not_configured" };
  const errors = [];
  let models = groqPoolFor(pool, hasImageContent(body));
  const live = await getLiveGroqIds(apiKey);
  if (live) {
    const pruned = models.filter((id) => live.has(id));
    if (pruned.length > 0) models = pruned;
  }
  const deadline = Date.now() + GROQ_BUDGET_MS;
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      errors.push(`groq ${model}: skipped, groq budget exhausted`);
      break;
    }
    try {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...body, model })
      }, Math.min(PER_MODEL_TIMEOUT_MS, remaining));
      if (!res.ok) {
        const err = await res.text();
        errors.push(`groq ${model}: ${res.status} ${err.slice(0, 100)}`);
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        errors.push(`groq ${model}: empty response`);
        continue;
      }
      return {
        response: text,
        model: data.model ?? model,
        provider: "groq",
        free: true,
        usage: data.usage ?? null
      };
    } catch (err) {
      errors.push(
        err && err.name === "AbortError" ? `groq ${model}: timed out` : `groq ${model}: ${String(err)}`
      );
    }
  }
  return { error: "all_groq_models_failed", tried: errors };
}
__name(groqWaterfall, "groqWaterfall");
async function inferWithWaterfall(pool, body, env, options = {}) {
  const tried = [];
  const note = /* @__PURE__ */ __name((r) => {
    if ("error" in r) tried.push(...r.tried ?? [r.error]);
  }, "note");
  const tiers = [];
  const paidTier = /* @__PURE__ */ __name(async () => hasPaidKeyConfigured(env) ? await callPaidFallback(body, env) : null, "paidTier");
  const groqTier = /* @__PURE__ */ __name(async () => env.GROQ_API_KEY ? await groqWaterfall(pool, body, env) : null, "groqTier");
  const freeTier = /* @__PURE__ */ __name(() => freeWaterfall(pool, body, env), "freeTier");
  if (options.preferPaid) tiers.push(paidTier, groqTier, freeTier);
  else tiers.push(groqTier, freeTier, paidTier);
  for (const tier of tiers) {
    const r = await tier();
    if (!r) continue;
    if (!("error" in r)) return r;
    note(r);
  }
  return { error: "all_free_models_failed", tried };
}
__name(inferWithWaterfall, "inferWithWaterfall");
async function describeEvidenceImages(imageUrls, incidentContext, env) {
  const system = `You are a factual image-description assistant for motorsport incident evidence.
Describe ONLY what is visibly happening in the image(s) \u2014 car positions, contact, track position, timing/HUD overlays if visible, any visible damage.
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
__name(describeEvidenceImages, "describeEvidenceImages");
var ESPN_RELAY_ALLOWED_HOST = "site.api.espn.com";
var ESPN_RELAY_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.espn.com/"
};
async function handleEspnRelay(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return jsonResponse({ error: "Missing url parameter" }, 400);
  }
  let targetUrl;
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
__name(handleEspnRelay, "handleEspnRelay");
async function handleInfer(request, env) {
  const body = await request.json();
  const mode = body.mode ?? "primary";
  const hasImage = Array.isArray(body.messages) && body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
  );
  const pool = poolForMode(mode, hasImage);
  const inferBody = {
    messages: body.messages ?? [
      ...body.system ? [{ role: "system", content: body.system }] : [],
      ...body.prompt ? [{ role: "user", content: body.prompt }] : []
    ],
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature ?? 0.3
  };
  const data = await inferWithWaterfall(pool, inferBody, env);
  if ("error" in data) return jsonResponse(data, 503);
  return jsonResponse(data);
}
__name(handleInfer, "handleInfer");
async function handleSteward(request, env) {
  const { incident, regulations = [], league = "AWC" } = await request.json();
  const regsBlock = regulations.length > 0 ? regulations.map((r) => `Article ${r.article_number} \u2014 ${r.title}:
${r.body}`).join("\n\n") : "No specific regulations provided. Apply standard racing conduct rules.";
  const reporterEvidence = incident.reporter_evidence ?? [];
  const accusedEvidence = incident.accused_evidence ?? [];
  const allEvidence = [...reporterEvidence, ...accusedEvidence];
  const imageEvidence = allEvidence.filter((e) => isLikelyImageUrl(e.url)).slice(0, MAX_EVIDENCE_IMAGES);
  const imageUrls = imageEvidence.map((e) => e.url);
  const incidentContext = `${incident.incident_type} incident, lap ${incident.lap ?? "?"}`;
  const [imageAnalysis, videoPass] = await Promise.all([
    imageUrls.length > 0 ? describeEvidenceImages(imageUrls, incidentContext, env) : Promise.resolve(null),
    analyseVideoEvidence(allEvidence, incidentContext, env)
  ]);
  const videoNotReviewed = videoPass.submitted > 0 && !videoPass.analysis;
  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON \u2014 no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }
Base your verdict on ALL evidence provided \u2014 the reporter's account, the accused driver's defense (if any), evidence links, the full ticket conversation transcript if included, and the image description if provided. The image description was produced by a separate vision pass and reflects only what is visibly observable \u2014 treat it as a factual account, not a verdict.`;
  const promptParts = [
    `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? "Unknown"} | LAP: ${incident.lap ?? "?"}`,
    `ACCUSED: ${incident.accused_username ?? "Unknown"}`,
    `REPORTER DESCRIPTION: ${incident.description}`
  ];
  if (reporterEvidence.length > 0) {
    promptParts.push(
      `REPORTER EVIDENCE LINKS:
${reporterEvidence.map((e) => `- ${e.label ? `${e.label}: ` : ""}${e.url}`).join("\n")}`
    );
  }
  if (incident.accused_response) {
    promptParts.push(`ACCUSED DRIVER'S DEFENSE: ${incident.accused_response}`);
  }
  if (accusedEvidence.length > 0) {
    promptParts.push(
      `ACCUSED EVIDENCE LINKS:
${accusedEvidence.map((e) => `- ${e.label ? `${e.label}: ` : ""}${e.url}`).join("\n")}`
    );
  }
  if (imageAnalysis) {
    promptParts.push(`IMAGE EVIDENCE DESCRIPTION (from vision pass):
${imageAnalysis.description}`);
  } else if (imageUrls.length > 0) {
    promptParts.push(`Note: ${imageUrls.length} evidence image(s) were submitted but could not be analyzed (link may have expired or failed to load).`);
  }
  if (videoPass.analysis) {
    promptParts.push(`VIDEO EVIDENCE DESCRIPTION (from video pass, observable facts only):
${videoPass.analysis.description}`);
  } else if (videoNotReviewed) {
    promptParts.push(`VIDEO EVIDENCE NOT REVIEWED: ${videoPass.submitted} evidence video(s) were submitted but the system could not watch them. You MUST NOT guess or infer what they show. If the outcome depends on what the video shows, return verdict "inconclusive" and state in steward_notes that a human steward must watch the video before ruling.`);
  }
  if (incident.ticket_transcript) {
    const transcript = String(incident.ticket_transcript).slice(0, 6e3);
    promptParts.push(`FULL TICKET CONVERSATION TRANSCRIPT:
${transcript}`);
  }
  promptParts.push(`REGULATIONS:
${regsBlock}`);
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
  const videoAnalysisMeta = videoPass.analysis ? { model: videoPass.analysis.model, usage: videoPass.analysis.usage, video_count: videoPass.analysis.video_count, via: videoPass.analysis.via } : null;
  const videoStatus = {
    submitted: videoPass.submitted,
    reviewed: Boolean(videoPass.analysis),
    not_reviewed: videoNotReviewed,
    reasons: videoPass.reasons ?? []
  };
  const imageAnalysisMeta = imageAnalysis ? { model: imageAnalysis.model, usage: imageAnalysis.usage, image_count: imageUrls.length } : null;
  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const suggestion = JSON.parse(raw);
    return jsonResponse({
      ...data,
      league,
      suggestion,
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
      video_status: videoStatus,
      disclaimer: "AI suggestion only. Human steward decision required."
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      suggestion: { verdict: "inconclusive", confidence: "low", parse_error: true, raw: data.response },
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
      video_status: videoStatus,
      disclaimer: "AI suggestion only. Human steward decision required."
    });
  }
}
__name(handleSteward, "handleSteward");
async function handleSetupFeedback(request, env) {
  const { feedback_text, known_param_keys = [], context = {}, league = "AWC" } = await request.json();
  if (!feedback_text || known_param_keys.length === 0) {
    return jsonResponse({ error: "feedback_text and known_param_keys are required" }, 400);
  }
  const paramKeysBlock = known_param_keys.map((k) => `- ${k}`).join("\n");
  const system = `You are a race engineering assistant for ${league} that converts driver setup feedback into structured parameter adjustments.
Return ONLY valid JSON \u2014 no markdown, no preamble.
VALID PARAM KEYS (you may ONLY use keys from this list \u2014 never invent a key):
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
    const parsed = JSON.parse(raw);
    const validKeys = new Set(known_param_keys);
    parsed.adjustments = (parsed.adjustments ?? []).filter(
      (a) => a && typeof a.param_key === "string" && validKeys.has(a.param_key) && typeof a.delta === "number" && ["low", "medium", "high"].includes(a.confidence)
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
__name(handleSetupFeedback, "handleSetupFeedback");
async function handleHealth(request, env) {
  if (new URL(request.url).searchParams.get("probe") !== "1") {
    return jsonResponse({
      status: "ok",
      source: "pitboss-proxy",
      probed: false,
      video_resolver_configured: Boolean(env.VIDEO_RESOLVER_URL && env.VIDEO_RESOLVER_KEY),
      models: MODELS
    });
  }
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
    probed: true,
    pools: probes.map((p) => p.status === "fulfilled" ? p.value : { error: String(p.reason) }),
    models: MODELS
  });
}
__name(handleHealth, "handleHealth");
function raceLights(raceTimeIso) {
  if (!raceTimeIso) return "";
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  const minsRemaining = msRemaining / 6e4;
  if (minsRemaining <= 0) return "\u{1F7E2}\u{1F7E2}\u{1F7E2}\u{1F7E2}\u{1F7E2}  **LIGHTS OUT \u2014 GO!**";
  if (minsRemaining <= 5) return "\u{1F534}\u{1F534}\u{1F534}\u{1F534}\u{1F534}  **Formation lap \u2014 get ready**";
  if (minsRemaining <= 30) return "\u{1F534}\u{1F534}\u{1F534}\u26AB\u26AB  **Grid forming**";
  if (minsRemaining <= 60) return "\u{1F534}\u{1F534}\u26AB\u26AB\u26AB  **Pit lane opens soon**";
  return "\u{1F534}\u26AB\u26AB\u26AB\u26AB  **Session upcoming**";
}
__name(raceLights, "raceLights");
function formatDigitalCountdown(raceTimeIso) {
  if (!raceTimeIso) return null;
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  if (msRemaining <= 0) return null;
  const totalSeconds = Math.floor(msRemaining / 1e3);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  const pad = /* @__PURE__ */ __name((n) => String(n).padStart(2, "0"), "pad");
  return `\u23F1 **${pad(hours)}:${pad(minutes)}:${pad(seconds)}**`;
}
__name(formatDigitalCountdown, "formatDigitalCountdown");
function refreshCountdownDescription(description, raceTimeIso) {
  const lines = description.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("\u23F0 **Start:**"));
  if (startIdx === -1) return description;
  const preludeEnd = startIdx > 0 && lines[startIdx - 1] === "\u2014\u2014\u2014\u2014\u2014" ? startIdx - 1 : startIdx;
  const head = lines.slice(0, preludeEnd);
  const unix = Math.floor(new Date(raceTimeIso).getTime() / 1e3);
  const rebuilt = [
    "\u2014\u2014\u2014\u2014\u2014",
    `\u23F0 **Start:** <t:${unix}:F>  (<t:${unix}:R>)`,
    raceLights(raceTimeIso)
  ];
  const digital = formatDigitalCountdown(raceTimeIso);
  if (digital) rebuilt.push(digital);
  return [...head, ...rebuilt].join("\n");
}
__name(refreshCountdownDescription, "refreshCountdownDescription");
var DISCORD_API_BASE = "https://discord.com/api/v10";
var IMMINENT_WINDOW_MS = 90 * 60 * 1e3;
var UPCOMING_WINDOW_MS = 48 * 60 * 60 * 1e3;
var UPCOMING_TICK_INTERVAL_MIN = 5;
async function fetchCheckinPosts(env, fromMs, toMs) {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const url = `${env.SUPABASE_URL}/rest/v1/round_checkin_posts?select=id,discord_channel_id,discord_message_id,race_time,description_frozen&race_time=gte.${from}&race_time=lte.${to}&discord_message_id=not.is.null&description_frozen=is.false`;
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
__name(fetchCheckinPosts, "fetchCheckinPosts");
async function fetchImminentCheckinPosts(env) {
  const now = Date.now();
  return fetchCheckinPosts(env, now, now + IMMINENT_WINDOW_MS);
}
__name(fetchImminentCheckinPosts, "fetchImminentCheckinPosts");
async function fetchUpcomingCheckinPosts(env) {
  const now = Date.now();
  return fetchCheckinPosts(env, now + IMMINENT_WINDOW_MS, now + UPCOMING_WINDOW_MS);
}
__name(fetchUpcomingCheckinPosts, "fetchUpcomingCheckinPosts");
function isUpcomingTierTick(scheduledTimeMs) {
  const minute = new Date(scheduledTimeMs).getUTCMinutes();
  return minute % UPCOMING_TICK_INTERVAL_MIN === 0;
}
__name(isUpcomingTierTick, "isUpcomingTierTick");
async function markPostFrozen(postId, env) {
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
__name(markPostFrozen, "markPostFrozen");
async function patchCheckinPost(post, token, env) {
  const msgRes = await fetch(
    `${DISCORD_API_BASE}/channels/${post.discord_channel_id}/messages/${post.discord_message_id}`,
    { headers: { Authorization: `Bot ${token}` } }
  );
  if (!msgRes.ok) {
    console.error(`[checkin-countdown] fetch message failed for post ${post.id}:`, msgRes.status);
    return false;
  }
  const message = await msgRes.json();
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
__name(patchCheckinPost, "patchCheckinPost");
async function handleCheckinCountdownTick(env, scheduledTimeMs = Date.now()) {
  const token = env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[checkin-countdown] PITBOSS_DISCORD_BOT_TOKEN not set \u2014 skipping tick.");
    return { checked: 0, patched: 0, error: "no_bot_token" };
  }
  const runUpcomingTier = isUpcomingTierTick(scheduledTimeMs);
  const [imminentPosts, upcomingPosts] = await Promise.all([
    fetchImminentCheckinPosts(env),
    runUpcomingTier ? fetchUpcomingCheckinPosts(env) : Promise.resolve([])
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
__name(handleCheckinCountdownTick, "handleCheckinCountdownTick");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const key = request.headers.get("X-PitBoss-Key");
    if (!await safeEqual(key, env.PITBOSS_INTERNAL_KEY)) {
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      handleCheckinCountdownTick(env, event.scheduledTime).then((result) => {
        console.log("[checkin-countdown] tick result:", JSON.stringify(result));
      })
    );
  }
};
export {
  index_default as default
};
