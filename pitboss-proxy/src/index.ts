interface Env {
  OPENROUTER_API_KEY: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_KEY?: string;
  OPENAI_KEY?: string;
  PITBOSS_INTERNAL_KEY: string;
  VIDEO_RESOLVER_URL?: string;
  VIDEO_RESOLVER_KEY?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  PITBOSS_DISCORD_BOT_TOKEN?: string;
}

type WaterfallSuccess = {
  response: string;
  model: string;
  provider: string;
  free: boolean;
  usage: any;
};
type WaterfallFailure = { error: string; tried?: string[] };
type WaterfallResult = WaterfallSuccess | WaterfallFailure;

type EvidenceItem = { url: string; label?: string };

const MODELS = {
  general: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3.5-lightning:free",
  ],
  reasoning: [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free",
  ],
  coding: [
    "poolside/laguna-s-2.1:free",
    "cohere/north-mini-code:free",
    "poolside/laguna-xs-2.1:free",
  ],
  vision: [
    "dots-studio/dots-3-note-preview:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-31b-it:free",
  ],
  // Video description pass (OpenRouter only: Groq has no video input).
  video: [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-31b-it:free",
  ],
  fast: [
    "nvidia/nemotron-3.5-lightning:free",
    "liquid/lfm-2.5-2.6b:free",
  ],
};

const PAID_FALLBACK: { model: string; key: "ANTHROPIC_KEY" | "OPENAI_KEY" }[] = [
  { model: "anthropic/claude-sonnet-5-5", key: "ANTHROPIC_KEY" },
  { model: "openai/gpt-4o-mini", key: "OPENAI_KEY" },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PitBoss-Key",
};

async function safeEqual(a: string | null, b: string | undefined): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return (crypto.subtle as any).timingSafeEqual(ha, hb);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

function isLikelyImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url.split("?")[0]);
}

const MAX_EVIDENCE_IMAGES = 4;

// ---------------------------------------------------------------------------
// Video evidence: resolve a submitted link to a direct video URL, then describe.
// Resolution order (first success wins):
//   1. direct file link (.mp4/.webm/.mov/.m4v) -> used as is
//   2. page tags (og:video etc.) for sites that expose a file (Medal, Streamable...)
//   3. external resolver service (yt-dlp) if VIDEO_RESOLVER_URL + VIDEO_RESOLVER_KEY set
//   4. Twitch GQL (legacy best-effort; often blocked from datacenter IPs)
// ---------------------------------------------------------------------------
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
const MAX_EVIDENCE_VIDEOS = 2;
// Paused: OpenRouter video models require >= $1.00 balance. Flip to true to re-enable.
const ENABLE_OPENROUTER_VIDEO_FALLBACK = false;
// Hard ceiling for the whole Gemini pass (download + upload + processing + generate).
const GEMINI_PASS_BUDGET_MS = 70_000;
const VIDEO_PASS_BUDGET_MS = 12_000;
const PAGE_FETCH_TIMEOUT_MS = 4_000;
const RESOLVER_TIMEOUT_MS = 20_000;
const TWITCH_RESOLVE_TIMEOUT_MS = 4_000;
const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const PAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const KNOWN_VIDEO_HOST_RE =
  /(^|\.)(medal\.tv|streamable\.com|twitch\.tv|youtube\.com|youtu\.be|x\.com|twitter\.com|vimeo\.com|outplayed\.tv|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|reddit\.com|v\.redd\.it|dubz\.link|streamff\.com|streamin\.one)$/i;
const NO_SCRAPE_HOST_RE =
  /(^|\.)(twitch\.tv|youtube\.com|youtu\.be|x\.com|twitter\.com|instagram\.com|tiktok\.com|facebook\.com|fb\.watch)$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, "");
  } catch {
    return null;
  }
}

function isDirectVideoUrl(url: string): boolean {
  try {
    return VIDEO_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function twitchClipSlug(url: string): string | null {
  let u: URL;
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

function isVideoEvidenceUrl(url: string): boolean {
  if (isDirectVideoUrl(url)) return true;
  const host = hostOf(url);
  return Boolean(host && KNOWN_VIDEO_HOST_RE.test(host));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

async function scrapeVideoUrl(pageUrl: string, reasons: string[]): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      pageUrl,
      {
        headers: { "User-Agent": PAGE_UA, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
      },
      PAGE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) {
      reasons.push(`page fetch ${res.status} for ${hostOf(pageUrl)}`);
      return null;
    }
    const html = (await res.text()).slice(0, 400_000);
    const wanted = ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"];
    const found: Record<string, string> = {};
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
        if (
          isDirectVideoUrl(abs) ||
          /\.(mp4|webm|mov|m4v)(\?|$)/i.test(abs) ||
          (/video|clip|cdn/i.test(abs) && !/\/embed|\/player/i.test(abs))
        )
          return abs;
      } catch {
        // ignore malformed candidate
      }
    }
    reasons.push(`no direct video tag on ${hostOf(pageUrl)}`);
    return null;
  } catch (err) {
    reasons.push(`page scrape failed for ${hostOf(pageUrl)}: ${String(err)}`);
    return null;
  }
}

async function callVideoResolver(url: string, env: Env, reasons: string[]): Promise<string | null> {
  try {
    const base = String(env.VIDEO_RESOLVER_URL).replace(/\/+$/, "");
    const res = await fetchWithTimeout(
      `${base}/resolve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Resolver-Key": env.VIDEO_RESOLVER_KEY as string,
        },
        body: JSON.stringify({ url }),
      },
      RESOLVER_TIMEOUT_MS
    );
    if (!res.ok) {
      reasons.push(`resolver http ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    if (data?.ok && data.url) return data.url as string;
    reasons.push(`resolver: ${String(data?.error ?? "no url returned").slice(0, 200)}`);
    return null;
  } catch (err) {
    reasons.push(`resolver unreachable: ${String(err)}`);
    return null;
  }
}

async function resolveTwitchClipUrl(slug: string, reasons: string[]): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      TWITCH_GQL_URL,
      {
        method: "POST",
        headers: {
          "Client-ID": TWITCH_WEB_CLIENT_ID,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            'query($slug: ID!){ clip(slug: $slug){ playbackAccessToken(params:{platform:"web",playerType:"site",playerBackend:"mediaplayer"}){ signature value } videoQualities{ frameRate quality sourceURL } } }',
          variables: { slug },
        }),
      },
      TWITCH_RESOLVE_TIMEOUT_MS
    );
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error("[video] twitch gql failed:", res.status, body);
      reasons.push(`twitch gql http ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    const clip = json?.data?.clip;
    const token = clip?.playbackAccessToken;
    const qualities = (clip?.videoQualities ?? []).filter((q: any) => q?.sourceURL);
    if (!token?.signature || !token?.value || qualities.length === 0) {
      console.error("[video] twitch gql returned no playable clip:", JSON.stringify(json).slice(0, 300));
      reasons.push("twitch gql returned no playable clip");
      return null;
    }
    qualities.sort((a: any, b: any) => Number(b.quality) - Number(a.quality));
    const pick = qualities.find((q: any) => Number(q.quality) <= 720) ?? qualities[qualities.length - 1];
    return `${pick.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
  } catch (err) {
    console.error("[video] twitch resolve threw:", String(err));
    reasons.push(`twitch gql error: ${String(err)}`);
    return null;
  }
}

type ResolvedVideo = { url: string; via: string };

async function resolveVideoUrl(url: string, env: Env, reasons: string[]): Promise<ResolvedVideo | null> {
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

// ---------------------------------------------------------------------------
// Gemini video pass (Google AI Studio free tier, no billing account needed).
// Clips within a 14 MB total budget go inline as base64. Larger clips are
// uploaded via the Gemini Files API and referenced by URI. Uploaded files are
// deleted after use (they otherwise auto-expire after 48h).
// Edit GEMINI_VIDEO_MODELS if Google renames or retires a model.
// ---------------------------------------------------------------------------
// gemini-2.5-flash / -flash-lite now 404 ("no longer available"); Google's listed
// replacements are gemini-3.5-flash and gemini-3.1-flash-lite.
const GEMINI_VIDEO_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_FILES_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_DOWNLOAD_TIMEOUT_MS = 20_000;
const GEMINI_UPLOAD_TIMEOUT_MS = 40_000;
const GEMINI_CALL_TIMEOUT_MS = 30_000;
const GEMINI_POLL_INTERVAL_MS = 2_000;
const GEMINI_POLL_MAX = 15;
const GEMINI_INLINE_BUDGET_BYTES = 14 * 1024 * 1024; // total across inline clips
const GEMINI_MAX_CLIP_BYTES = 80 * 1024 * 1024; // Worker memory guard (128 MB limit)

type GeminiClip =
  | { kind: "inline"; mime: string; data: string; bytes: number }
  | { kind: "file"; mime: string; uri: string; name: string; bytes: number };

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

function mimeFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".webm")) return "video/webm";
    if (path.endsWith(".mov")) return "video/quicktime";
  } catch {
    // fall through to default
  }
  return "video/mp4";
}

function withBudget<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

async function downloadClip(
  url: string,
  reasons: string[]
): Promise<{ mime: string; buf: ArrayBuffer } | null> {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": PAGE_UA }, redirect: "follow" },
      GEMINI_DOWNLOAD_TIMEOUT_MS
    );
    if (!res.ok) {
      reasons.push(`gemini: download http ${res.status} for ${hostOf(url)}`);
      return null;
    }
    const tooBig = () =>
      reasons.push(
        `gemini: clip from ${hostOf(url)} exceeds ${Math.floor(GEMINI_MAX_CLIP_BYTES / 1048576)} MB cap`
      );
    const declared = Number(res.headers.get("Content-Length") ?? 0);
    if (declared > GEMINI_MAX_CLIP_BYTES) {
      tooBig();
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > GEMINI_MAX_CLIP_BYTES) {
      tooBig();
      return null;
    }
    const headerMime = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    const mime = headerMime.startsWith("video/") ? headerMime : mimeFromUrl(url);
    return { mime, buf };
  } catch (err) {
    reasons.push(`gemini: download failed for ${hostOf(url)}: ${String(err)}`);
    return null;
  }
}

async function uploadClipToGeminiFiles(
  buf: ArrayBuffer,
  mime: string,
  apiKey: string,
  host: string | null,
  reasons: string[]
): Promise<GeminiClip | null> {
  try {
    // 1. start resumable upload
    const start = await fetchWithTimeout(
      `${GEMINI_FILES_BASE}/upload/v1beta/files`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(buf.byteLength),
          "X-Goog-Upload-Header-Content-Type": mime,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: "incident-clip" } }),
      },
      GEMINI_CALL_TIMEOUT_MS
    );
    if (!start.ok) {
      reasons.push(`gemini: files start http ${start.status} for ${host}: ${(await start.text()).slice(0, 120)}`);
      return null;
    }
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      reasons.push(`gemini: files start returned no upload url for ${host}`);
      return null;
    }

    // 2. upload bytes + finalize
    const up = await fetchWithTimeout(
      uploadUrl,
      {
        method: "POST",
        headers: {
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: buf,
      },
      GEMINI_UPLOAD_TIMEOUT_MS
    );
    if (!up.ok) {
      reasons.push(`gemini: files upload http ${up.status} for ${host}: ${(await up.text()).slice(0, 120)}`);
      return null;
    }
    let file: any = ((await up.json()) as any)?.file;

    // 3. wait for processing to finish
    for (let i = 0; i < GEMINI_POLL_MAX && file?.state === "PROCESSING"; i++) {
      await new Promise((r) => setTimeout(r, GEMINI_POLL_INTERVAL_MS));
      const poll = await fetchWithTimeout(
        `${GEMINI_FILES_BASE}/v1beta/${file.name}`,
        { headers: { "x-goog-api-key": apiKey } },
        5_000
      );
      if (!poll.ok) break;
      file = await poll.json();
    }
    if (!file?.uri || file.state !== "ACTIVE") {
      reasons.push(`gemini: uploaded clip from ${host} not ready (state ${file?.state ?? "unknown"})`);
      return null;
    }
    return { kind: "file", mime: file.mimeType ?? mime, uri: file.uri, name: file.name, bytes: buf.byteLength };
  } catch (err) {
    reasons.push(`gemini: files upload failed for ${host}: ${String(err).slice(0, 160)}`);
    return null;
  }
}

async function deleteGeminiFile(name: string, apiKey: string): Promise<void> {
  try {
    await fetchWithTimeout(
      `${GEMINI_FILES_BASE}/v1beta/${name}`,
      { method: "DELETE", headers: { "x-goog-api-key": apiKey } },
      5_000
    );
  } catch {
    // best-effort; files auto-expire after 48h
  }
}

async function describeVideosWithGemini(
  resolved: ResolvedVideo[],
  system: string,
  prompt: string,
  env: Env,
  reasons: string[]
): Promise<{ response: string; model: string; usage: any; clipCount: number } | null> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    reasons.push("gemini skipped: GEMINI_API_KEY not set on this worker");
    return null;
  }

  const clips: GeminiClip[] = [];
  try {
    let remainingInline = GEMINI_INLINE_BUDGET_BYTES;
    for (const r of resolved) {
      const dl = await downloadClip(r.url, reasons);
      if (!dl) continue;
      if (dl.buf.byteLength <= remainingInline) {
        remainingInline -= dl.buf.byteLength;
        clips.push({
          kind: "inline",
          mime: dl.mime,
          data: arrayBufferToBase64(dl.buf),
          bytes: dl.buf.byteLength,
        });
      } else {
        const uploaded = await uploadClipToGeminiFiles(dl.buf, dl.mime, apiKey, hostOf(r.url), reasons);
        if (uploaded) clips.push(uploaded);
      }
    }
    if (clips.length === 0) return null;

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...clips.map((c) =>
              c.kind === "inline"
                ? { inline_data: { mime_type: c.mime, data: c.data } }
                : { file_data: { mime_type: c.mime, file_uri: c.uri } }
            ),
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 900, temperature: 0.1 },
    };

    const errors: string[] = [];
    for (const model of GEMINI_VIDEO_MODELS) {
      try {
        const res = await fetchWithTimeout(
          `${GEMINI_API_BASE}/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(body),
          },
          GEMINI_CALL_TIMEOUT_MS
        );
        if (!res.ok) {
          errors.push(`${model}: ${res.status} ${(await res.text()).slice(0, 160)}`);
          continue;
        }
        const json: any = await res.json();
        const text = (json?.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text ?? "")
          .join("")
          .trim();
        if (!text) {
          const why = json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? "no reason given";
          errors.push(`${model}: empty response (${why})`);
          continue;
        }
        return {
          response: text,
          model: json?.modelVersion ?? model,
          usage: json?.usageMetadata ?? null,
          clipCount: clips.length,
        };
      } catch (err: any) {
        errors.push(
          err && err.name === "AbortError"
            ? `${model}: timed out after ${GEMINI_CALL_TIMEOUT_MS}ms`
            : `${model}: ${String(err).slice(0, 160)}`
        );
      }
    }
    console.error("[video] gemini pass failed:", JSON.stringify(errors));
    reasons.push(`gemini failed: ${errors.join(" | ")}`);
    return null;
  } finally {
    await Promise.all(
      clips
        .filter((c): c is Extract<GeminiClip, { kind: "file" }> => c.kind === "file")
        .map((c) => deleteGeminiFile(c.name, apiKey))
    );
  }
}

type VideoPassResult = {
  submitted: number;
  analysis: {
    description: string;
    model: string;
    usage: any;
    video_count: number;
    via: string[];
  } | null;
  reasons: string[];
};

async function analyseVideoEvidence(
  evidence: EvidenceItem[],
  incidentContext: string,
  env: Env
): Promise<VideoPassResult> {
  const seen = new Set<string>();
  const candidates = evidence
    .filter((e) => isVideoEvidenceUrl(e.url))
    .filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
    .slice(0, MAX_EVIDENCE_VIDEOS);
  const submitted = candidates.length;
  const reasons: string[] = [];
  if (submitted === 0) return { submitted: 0, analysis: null, reasons };

  const results = await Promise.all(candidates.map((e) => resolveVideoUrl(e.url, env, reasons)));
  const resolved = results.filter((r): r is ResolvedVideo => Boolean(r));
  console.log(
    "[video] resolved:",
    JSON.stringify(results.map((r, i) => ({ src: hostOf(candidates[i].url), via: r?.via ?? null })))
  );
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

  // Gemini (free tier, no balance needed), bounded by a hard overall budget.
  const gemini = await withBudget(
    describeVideosWithGemini(resolved, system, prompt, env, reasons),
    GEMINI_PASS_BUDGET_MS,
    () => reasons.push(`gemini: pass exceeded ${GEMINI_PASS_BUDGET_MS / 1000}s budget`)
  );
  if (gemini) {
    return {
      submitted,
      reasons,
      analysis: {
        description: gemini.response,
        model: gemini.model,
        usage: gemini.usage,
        video_count: gemini.clipCount,
        via: resolved.map((r) => r.via),
      },
    };
  }

  if (!ENABLE_OPENROUTER_VIDEO_FALLBACK) {
    // Paused: Gemini already recorded its own failure reasons. Nothing else to try.
    return { submitted, analysis: null, reasons };
  }

  const data = await freeWaterfall(
    MODELS.video,
    {
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...resolved.map((r) => ({ type: "video_url", video_url: { url: r.url } })),
          ],
        },
      ],
      max_tokens: 900,
      temperature: 0.1,
    },
    env,
    VIDEO_PASS_BUDGET_MS
  );

  if ("error" in data) {
    console.error("[video] description pass failed:", JSON.stringify(data.tried ?? data.error));
    // Include each model's actual failure (timeout, rate limit, HTTP status) in the
    // reasons so /steward analyse can show WHY the video pass failed. The org prefix
    // and ":free" suffix are stripped from the model name to keep each entry short.
    const detail = (data.tried ?? [data.error])
      .slice(0, 2)
      .map((t) => String(t).replace(/^[^/\s]+\//, "").replace(":free", "").slice(0, 160))
      .join(" | ");
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
      via: resolved.map((r) => r.via),
    },
  };
}

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

const PER_MODEL_TIMEOUT_MS = 10_000;
const FREE_WATERFALL_BUDGET_MS = 10_000;
const GROQ_BUDGET_MS = 5_000;
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

function hasPaidKeyConfigured(env: Env): boolean {
  return Boolean(env.ANTHROPIC_KEY || env.OPENAI_KEY);
}

function hasImageContent(body: any): boolean {
  const messages = body.messages;
  return (
    Array.isArray(messages) &&
    messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"))
  );
}

function toAnthropicPayload(messages: any[]): { system?: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages ?? []) {
    if (m.role === "system") {
      systemParts.push(
        typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("")
      );
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: any[] = [];
    for (const p of m.content ?? []) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text ?? "" });
      } else if (p.type === "image_url") {
        const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
        if (!url) continue;
        const dataMatch = /^data:([^;]+);base64,(.+)$/s.exec(url);
        parts.push(
          dataMatch
            ? { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } }
            : { type: "image", source: { type: "url", url } }
        );
      }
    }
    out.push({ role: m.role, content: parts });
  }
  return systemParts.length ? { system: systemParts.join("\n\n"), messages: out } : { messages: out };
}

async function callPaidFallback(body: any, env: Env): Promise<WaterfallSuccess | null> {
  const deadline = Date.now() + PAID_FALLBACK_BUDGET_MS;
  for (const { model, key } of PAID_FALLBACK) {
    const apiKey = env[key];
    if (!apiKey) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = Math.min(PER_MODEL_TIMEOUT_MS, remaining);
    try {
      if (model.startsWith("anthropic/")) {
        const res2 = await fetchWithTimeout(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: model.replace("anthropic/", ""),
              max_tokens: body.max_tokens ?? 1024,
              ...toAnthropicPayload(body.messages),
            }),
          },
          timeout
        );
        if (!res2.ok) {
          console.error(`[paid-fallback] ${model} failed:`, res2.status, (await res2.text()).slice(0, 200));
          continue;
        }
        const data2: any = await res2.json();
        const text = (data2.content ?? []).map((b: any) => b.text ?? "").join("");
        return {
          response: text,
          model: data2.model ?? model,
          provider: "anthropic:paid",
          free: false,
          usage: data2.usage ?? null,
        };
      }
      const res = await fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ ...body, model: model.replace("openai/", "") }),
        },
        timeout
      );
      if (!res.ok) {
        console.error(`[paid-fallback] ${model} failed:`, res.status, (await res.text()).slice(0, 200));
        continue;
      }
      const data: any = await res.json();
      return {
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: "openai:paid",
        free: false,
        usage: data.usage ?? null,
      };
    } catch (err) {
      console.error(`[paid-fallback] ${model} threw:`, String(err));
      continue;
    }
  }
  return null;
}

const LIVE_TTL_MS = 60 * 60 * 1000;
const LIVE_FETCH_TIMEOUT_MS = 3_000;
const EXPIRY_GUARD_MS = 48 * 60 * 60 * 1000;
const MIN_LIVE_MODELS = 5;
const MIN_POOL_SIZE = 2;
const MAX_BACKFILL = 2;
const BACKFILL_EXCLUDE = /inkling|content-safety|guard|lyria|tts|embed|^openrouter\/|^stealth\//i;

type LiveModel = { id: string; image: boolean; ctx: number };
let liveCache: { at: number; models: Map<string, LiveModel> } | null = null;

async function getLiveFreeModels(): Promise<Map<string, LiveModel> | null> {
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.models;
  try {
    const res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/models",
      { headers: { Accept: "application/json" } },
      LIVE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return liveCache?.models ?? null;
    const json: any = await res.json();
    const out = new Map<string, LiveModel>();
    for (const m of json?.data ?? []) {
      if (!m?.id) continue;
      const free = Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;
      if (!free) continue;
      const outputs: string[] = m.architecture?.output_modalities ?? ["text"];
      if (!outputs.includes("text")) continue;
      if (m.expiration_date) {
        const exp = Date.parse(m.expiration_date);
        if (!Number.isNaN(exp) && exp - Date.now() < EXPIRY_GUARD_MS) continue;
      }
      const inputs: string[] = m.architecture?.input_modalities ?? ["text"];
      out.set(m.id, {
        id: m.id,
        image: inputs.includes("image"),
        ctx: Number(m.context_length) || 0,
      });
    }
    if (out.size < MIN_LIVE_MODELS) return liveCache?.models ?? null;
    liveCache = { at: Date.now(), models: out };
    return out;
  } catch {
    return liveCache?.models ?? null;
  }
}

async function reconcilePool(pool: string[], needImage: boolean): Promise<string[]> {
  const live = await getLiveFreeModels();
  if (!live) return pool;
  const kept = pool.filter((id) => live.has(id));
  if (kept.length < MIN_POOL_SIZE) {
    const extras = [...live.values()]
      .filter((m) => !kept.includes(m.id))
      .filter((m) => !BACKFILL_EXCLUDE.test(m.id))
      .filter((m) => !needImage || m.image)
      .sort((a, b) => b.ctx - a.ctx)
      .slice(0, MAX_BACKFILL)
      .map((m) => m.id);
    kept.push(...extras);
  }
  return kept.length > 0 ? kept : pool;
}

async function freeWaterfall(
  pool: string[],
  body: any,
  env: Env,
  budgetMs: number = FREE_WATERFALL_BUDGET_MS
): Promise<WaterfallResult> {
  const openrouterKey = env.OPENROUTER_API_KEY;
  const errors: string[] = [];
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
      const res = await fetchWithTimeout(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openrouterKey}`,
            "HTTP-Referer": "https://rise-os.app",
            "X-Title": "PitBoss Internal LLM",
          },
          body: JSON.stringify({ ...body, model }),
        },
        timeout
      );
      if (res.status === 429 || res.status === 503) {
        errors.push(`${model}: rate limited`);
        continue;
      }
      if (res.status === 402) {
        // Account-wide balance problem: the next model would fail the same way.
        const err = await res.text();
        errors.push(`${model}: 402 insufficient OpenRouter balance (${err.slice(0, 120)})`);
        break;
      }
      if (!res.ok) {
        const err = await res.text();
        // Limit raised from 100 to 300 so the provider's full message is kept.
        errors.push(`${model}: ${res.status} ${err.slice(0, 300)}`);
        continue;
      }
      const data: any = await res.json();
      return {
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: "openrouter:free",
        free: true,
        usage: data.usage ?? null,
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

const GROQ_MODELS: Record<string, string[]> = {
  general: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  reasoning: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  coding: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  vision: ["meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3.6-27b"],
  fast: ["llama-3.1-8b-instant", "openai/gpt-oss-20b"],
};

let groqLiveCache: { at: number; ids: Set<string> } | null = null;

async function getLiveGroqIds(apiKey: string): Promise<Set<string> | null> {
  if (groqLiveCache && Date.now() - groqLiveCache.at < LIVE_TTL_MS) return groqLiveCache.ids;
  try {
    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${apiKey}` } },
      LIVE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return groqLiveCache?.ids ?? null;
    const json: any = await res.json();
    const ids = new Set<string>((json?.data ?? []).map((m: any) => m.id as string));
    if (ids.size < 3) return groqLiveCache?.ids ?? null;
    groqLiveCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return groqLiveCache?.ids ?? null;
  }
}

function groqPoolFor(pool: string[], hasImage: boolean): string[] {
  if (hasImage) return GROQ_MODELS.vision;
  for (const key of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
    if (MODELS[key] === pool) return GROQ_MODELS[key];
  }
  return GROQ_MODELS.general;
}

async function groqWaterfall(pool: string[], body: any, env: Env): Promise<WaterfallResult> {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return { error: "groq_not_configured" };
  const errors: string[] = [];
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
      const res = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ ...body, model }),
        },
        Math.min(PER_MODEL_TIMEOUT_MS, remaining)
      );
      if (!res.ok) {
        const err = await res.text();
        errors.push(`groq ${model}: ${res.status} ${err.slice(0, 100)}`);
        continue;
      }
      const data: any = await res.json();
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
        usage: data.usage ?? null,
      };
    } catch (err: any) {
      errors.push(
        err && err.name === "AbortError" ? `groq ${model}: timed out` : `groq ${model}: ${String(err)}`
      );
    }
  }
  return { error: "all_groq_models_failed", tried: errors };
}

async function inferWithWaterfall(
  pool: string[],
  body: any,
  env: Env,
  options: { preferPaid?: boolean } = {}
): Promise<WaterfallResult> {
  const tried: string[] = [];
  const note = (r: WaterfallResult) => {
    if ("error" in r) tried.push(...(r.tried ?? [r.error]));
  };
  const tiers: Array<() => Promise<WaterfallResult | null>> = [];
  const paidTier = async (): Promise<WaterfallResult | null> =>
    hasPaidKeyConfigured(env) ? await callPaidFallback(body, env) : null;
  const groqTier = async (): Promise<WaterfallResult | null> =>
    env.GROQ_API_KEY ? await groqWaterfall(pool, body, env) : null;
  const freeTier = (): Promise<WaterfallResult | null> => freeWaterfall(pool, body, env);
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

async function describeEvidenceImages(
  imageUrls: string[],
  incidentContext: string,
  env: Env
): Promise<{ description: string; model: string; usage: any } | null> {
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
            ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
      max_tokens: 700,
      temperature: 0.1,
    },
    env
  );
  if ("error" in data) return null;
  return {
    description: data.response,
    model: data.model,
    usage: data.usage ?? null,
  };
}

const ESPN_RELAY_ALLOWED_HOST = "site.api.espn.com";
const ESPN_RELAY_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.espn.com/",
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
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: "espn_relay_fetch_failed", message: String(err) }, 502);
  }
}

async function handleInfer(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const mode: string = body.mode ?? "primary";
  const hasImage =
    Array.isArray(body.messages) &&
    body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"));
  const pool = poolForMode(mode, hasImage);
  const inferBody = {
    messages:
      body.messages ??
      [
        ...(body.system ? [{ role: "system", content: body.system }] : []),
        ...(body.prompt ? [{ role: "user", content: body.prompt }] : []),
      ],
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature ?? 0.3,
  };
  const data = await inferWithWaterfall(pool, inferBody, env);
  if ("error" in data) return jsonResponse(data, 503);
  return jsonResponse(data);
}

async function handleSteward(request: Request, env: Env): Promise<Response> {
  const { incident, regulations = [], league = "AWC" } = (await request.json()) as any;

  const regsBlock =
    regulations.length > 0
      ? regulations.map((r: any) => `Article ${r.article_number} \u2014 ${r.title}:\n${r.body}`).join("\n\n")
      : "No specific regulations provided. Apply standard racing conduct rules.";

  const reporterEvidence: EvidenceItem[] = incident.reporter_evidence ?? [];
  const accusedEvidence: EvidenceItem[] = incident.accused_evidence ?? [];
  const allEvidence = [...reporterEvidence, ...accusedEvidence];

  const imageEvidence = allEvidence.filter((e) => isLikelyImageUrl(e.url)).slice(0, MAX_EVIDENCE_IMAGES);
  const imageUrls = imageEvidence.map((e) => e.url);
  const incidentContext = `${incident.incident_type} incident, lap ${incident.lap ?? "?"}`;

  const [imageAnalysis, videoPass] = await Promise.all([
    imageUrls.length > 0 ? describeEvidenceImages(imageUrls, incidentContext, env) : Promise.resolve(null),
    analyseVideoEvidence(allEvidence, incidentContext, env),
  ]);
  const videoNotReviewed = videoPass.submitted > 0 && !videoPass.analysis;

  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON \u2014 no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }
Base your verdict on ALL evidence provided \u2014 the reporter's account, the accused driver's defense (if any), evidence links, the full ticket conversation transcript if included, and the image description if provided. The image description was produced by a separate vision pass and reflects only what is visibly observable \u2014 treat it as a factual account, not a verdict.`;

  const promptParts: string[] = [
    `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? "Unknown"} | LAP: ${incident.lap ?? "?"}`,
    `ACCUSED: ${incident.accused_username ?? "Unknown"}`,
    `REPORTER DESCRIPTION: ${incident.description}`,
  ];
  if (reporterEvidence.length > 0) {
    promptParts.push(
      `REPORTER EVIDENCE LINKS:\n${reporterEvidence
        .map((e) => `- ${e.label ? `${e.label}: ` : ""}${e.url}`)
        .join("\n")}`
    );
  }
  if (incident.accused_response) {
    promptParts.push(`ACCUSED DRIVER'S DEFENSE: ${incident.accused_response}`);
  }
  if (accusedEvidence.length > 0) {
    promptParts.push(
      `ACCUSED EVIDENCE LINKS:\n${accusedEvidence
        .map((e) => `- ${e.label ? `${e.label}: ` : ""}${e.url}`)
        .join("\n")}`
    );
  }
  if (imageAnalysis) {
    promptParts.push(`IMAGE EVIDENCE DESCRIPTION (from vision pass):\n${imageAnalysis.description}`);
  } else if (imageUrls.length > 0) {
    promptParts.push(
      `Note: ${imageUrls.length} evidence image(s) were submitted but could not be analyzed (link may have expired or failed to load).`
    );
  }
  if (videoPass.analysis) {
    promptParts.push(
      `VIDEO EVIDENCE DESCRIPTION (from video pass, observable facts only):\n${videoPass.analysis.description}`
    );
  } else if (videoNotReviewed) {
    promptParts.push(
      `VIDEO EVIDENCE NOT REVIEWED: ${videoPass.submitted} evidence video(s) were submitted but the system could not watch them. You MUST NOT guess or infer what they show. If the outcome depends on what the video shows, return verdict "inconclusive" and state in steward_notes that a human steward must watch the video before ruling.`
    );
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
        { role: "user", content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    },
    env
  );
  if ("error" in data) return jsonResponse(data, 503);

  const videoAnalysisMeta = videoPass.analysis
    ? {
        model: videoPass.analysis.model,
        usage: videoPass.analysis.usage,
        video_count: videoPass.analysis.video_count,
        via: videoPass.analysis.via,
      }
    : null;
  const videoStatus = {
    submitted: videoPass.submitted,
    reviewed: Boolean(videoPass.analysis),
    not_reviewed: videoNotReviewed,
    reasons: [...new Set(videoPass.reasons ?? [])],
  };
  const imageAnalysisMeta = imageAnalysis
    ? { model: imageAnalysis.model, usage: imageAnalysis.usage, image_count: imageUrls.length }
    : null;

  try {
    const raw = data.response
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const suggestion = JSON.parse(raw);
    return jsonResponse({
      ...data,
      league,
      suggestion,
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
      video_status: videoStatus,
      disclaimer: "AI suggestion only. Human steward decision required.",
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      suggestion: { verdict: "inconclusive", confidence: "low", parse_error: true, raw: data.response },
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
      video_status: videoStatus,
      disclaimer: "AI suggestion only. Human steward decision required.",
    });
  }
}

async function handleSetupFeedback(request: Request, env: Env): Promise<Response> {
  const {
    feedback_text,
    known_param_keys = [],
    context = {},
    league = "AWC",
  } = (await request.json()) as any;

  if (!feedback_text || known_param_keys.length === 0) {
    return jsonResponse({ error: "feedback_text and known_param_keys are required" }, 400);
  }

  const paramKeysBlock = known_param_keys.map((k: string) => `- ${k}`).join("\n");
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
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    },
    env
  );
  if ("error" in data) return jsonResponse(data, 503);

  const disclaimer = "AI-generated suggestion. Review before applying to setup.";
  try {
    const raw = data.response
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(raw);
    const validKeys = new Set<string>(known_param_keys);
    parsed.adjustments = (parsed.adjustments ?? []).filter(
      (a: any) =>
        a &&
        typeof a.param_key === "string" &&
        validKeys.has(a.param_key) &&
        typeof a.delta === "number" &&
        ["low", "medium", "high"].includes(a.confidence)
    );
    return jsonResponse({
      ...data,
      league,
      adjustments: parsed.adjustments,
      summary: parsed.summary ?? "",
      disclaimer,
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      adjustments: [],
      summary: "",
      raw: data.response,
      parse_error: true,
      disclaimer,
    });
  }
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).searchParams.get("probe") !== "1") {
    return jsonResponse({
      status: "ok",
      source: "pitboss-proxy",
      probed: false,
      video_resolver_configured: Boolean(env.VIDEO_RESOLVER_URL && env.VIDEO_RESOLVER_KEY),
      openrouter_video_fallback_enabled: ENABLE_OPENROUTER_VIDEO_FALLBACK,
      models: MODELS,
    });
  }

  const probes = await Promise.allSettled(
    Object.entries(MODELS).map(async ([pool, models]) => {
      const start = Date.now();
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: models[0],
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 3,
        }),
      });
      return { pool, model: models[0], status: res.ok ? "ok" : res.status, latencyMs: Date.now() - start };
    })
  );
  return jsonResponse({
    status: "ok",
    source: "pitboss-proxy",
    probed: true,
    pools: probes.map((p) => (p.status === "fulfilled" ? p.value : { error: String(p.reason) })),
    models: MODELS,
  });
}

function raceLights(raceTimeIso: string | null | undefined): string {
  if (!raceTimeIso) return "";
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  const minsRemaining = msRemaining / 60_000;
  if (minsRemaining <= 0) return "\u{1F7E2}\u{1F7E2}\u{1F7E2}\u{1F7E2}\u{1F7E2}  **LIGHTS OUT \u2014 GO!**";
  if (minsRemaining <= 5) return "\u{1F534}\u{1F534}\u{1F534}\u{1F534}\u{1F534}  **Formation lap \u2014 get ready**";
  if (minsRemaining <= 30) return "\u{1F534}\u{1F534}\u{1F534}\u26AB\u26AB  **Grid forming**";
  if (minsRemaining <= 60) return "\u{1F534}\u{1F534}\u26AB\u26AB\u26AB  **Pit lane opens soon**";
  return "\u{1F534}\u26AB\u26AB\u26AB\u26AB  **Session upcoming**";
}

function formatDigitalCountdown(raceTimeIso: string | null | undefined): string | null {
  if (!raceTimeIso) return null;
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  if (msRemaining <= 0) return null;
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `\u23F1 **${pad(hours)}:${pad(minutes)}:${pad(seconds)}**`;
}

function refreshCountdownDescription(description: string, raceTimeIso: string): string {
  const lines = description.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("\u23F0 **Start:**"));
  if (startIdx === -1) return description;

  const preludeEnd =
    startIdx > 0 && lines[startIdx - 1] === "\u2014\u2014\u2014\u2014\u2014" ? startIdx - 1 : startIdx;
  const head = lines.slice(0, preludeEnd);

  const unix = Math.floor(new Date(raceTimeIso).getTime() / 1000);
  const rebuilt = [
    "\u2014\u2014\u2014\u2014\u2014",
    `\u23F0 **Start:** <t:${unix}:F>  (<t:${unix}:R>)`,
    raceLights(raceTimeIso),
  ];
  const digital = formatDigitalCountdown(raceTimeIso);
  if (digital) rebuilt.push(digital);

  return [...head, ...rebuilt].join("\n");
}

const DISCORD_API_BASE = "https://discord.com/api/v10";
const IMMINENT_WINDOW_MS = 90 * 60 * 1000;
const UPCOMING_WINDOW_MS = 48 * 60 * 60 * 1000;
const UPCOMING_TICK_INTERVAL_MIN = 5;

type CheckinPost = {
  id: string;
  discord_channel_id: string;
  discord_message_id: string;
  race_time: string;
  description_frozen: boolean;
};

async function fetchCheckinPosts(env: Env, fromMs: number, toMs: number): Promise<CheckinPost[]> {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const url = `${env.SUPABASE_URL}/rest/v1/round_checkin_posts?select=id,discord_channel_id,discord_message_id,race_time,description_frozen&race_time=gte.${from}&race_time=lte.${to}&discord_message_id=not.is.null&description_frozen=is.false`;
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
  return (await res.json()) as CheckinPost[];
}

async function fetchImminentCheckinPosts(env: Env): Promise<CheckinPost[]> {
  const now = Date.now();
  return fetchCheckinPosts(env, now, now + IMMINENT_WINDOW_MS);
}

async function fetchUpcomingCheckinPosts(env: Env): Promise<CheckinPost[]> {
  const now = Date.now();
  return fetchCheckinPosts(env, now + IMMINENT_WINDOW_MS, now + UPCOMING_WINDOW_MS);
}

function isUpcomingTierTick(scheduledTimeMs: number): boolean {
  const minute = new Date(scheduledTimeMs).getUTCMinutes();
  return minute % UPCOMING_TICK_INTERVAL_MIN === 0;
}

async function markPostFrozen(postId: string, env: Env): Promise<void> {
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

async function patchCheckinPost(post: CheckinPost, token: string, env: Env): Promise<boolean> {
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
      body: JSON.stringify({ embeds: [{ ...embed, description: newDescription }] }),
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

async function handleCheckinCountdownTick(env: Env, scheduledTimeMs: number = Date.now()) {
  const token = env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[checkin-countdown] PITBOSS_DISCORD_BOT_TOKEN not set \u2014 skipping tick.");
    return { checked: 0, patched: 0, error: "no_bot_token" };
  }

  const runUpcomingTier = isUpcomingTierTick(scheduledTimeMs);
  const [imminentPosts, upcomingPosts] = await Promise.all([
    fetchImminentCheckinPosts(env),
    runUpcomingTier ? fetchUpcomingCheckinPosts(env) : Promise.resolve([] as CheckinPost[]),
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
    ranUpcomingTier: runUpcomingTier,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const key = request.headers.get("X-PitBoss-Key");
    if (!(await safeEqual(key, env.PITBOSS_INTERNAL_KEY))) {
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleCheckinCountdownTick(env, event.scheduledTime).then((result) => {
        console.log("[checkin-countdown] tick result:", JSON.stringify(result));
      })
    );
  },
};
