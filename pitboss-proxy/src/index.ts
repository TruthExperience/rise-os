"""
Adds a video-evidence pass to pitboss-proxy/src/index.ts.

Usage (from the worker folder):  python apply_video_patch.py src/index.ts

Every edit asserts its anchor matches exactly the expected number of times
before anything is written. If any anchor misses, nothing is changed.
"""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "src/index.ts"
raw = open(path, encoding="utf-8", newline="").read()
crlf = "\r\n" in raw
src = raw.replace("\r\n", "\n")


def P(s):
    return s.strip("\n")


edits = []

# 1. Video model pool -------------------------------------------------------
edits.append((1, P(r"""
  fast: [
"""), P(r"""
  // Video description pass (OpenRouter only: Groq has no video input).
  // Both models are listed as accepting video. Order = preference.
  video: [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-31b-it:free"
  ],

  fast: [
""")))

# 2. freeWaterfall: optional budget ------------------------------------------
edits.append((1, P(r"""
async function freeWaterfall(pool: string[], body: any, env: any): Promise<InferResult | InferError> {
"""), P(r"""
async function freeWaterfall(
  pool: string[],
  body: any,
  env: any,
  budgetMs: number = FREE_WATERFALL_BUDGET_MS
): Promise<InferResult | InferError> {
""")))

edits.append((1, P(r"""
  const deadline = Date.now() + FREE_WATERFALL_BUDGET_MS;
"""), P(r"""
  const deadline = Date.now() + budgetMs;
""")))

# 3. Video helpers ------------------------------------------------------------
VIDEO_HELPERS = r"""
const MAX_EVIDENCE_IMAGES = 4;

// ─── Evidence-video helpers ──────────────────────────────────────────────────
// Direct video files (.mp4/.webm/.mov/.m4v, e.g. Discord or Supabase uploads)
// and Twitch clip links get a video-description pass, run in parallel with the
// image pass. Twitch clip pages are JS-rendered, so the page URL is resolved
// to a signed mp4 URL via Twitch's unofficial GQL endpoint first. That endpoint
// is undocumented and can change or start demanding integrity tokens; on any
// failure we return null and the caller reports the video as not analyzed.

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i;
const MAX_EVIDENCE_VIDEOS = 2;
const VIDEO_PASS_BUDGET_MS = 12_000;
const TWITCH_RESOLVE_TIMEOUT_MS = 4_000;
const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
// Public client id used by twitch.tv's own web player.
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

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
  return isDirectVideoUrl(url) || twitchClipSlug(url) !== null;
}

async function resolveTwitchClipUrl(slug: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(TWITCH_GQL_URL, {
      method: "POST",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query:
          "query($slug: ID!){ clip(slug: $slug){ playbackAccessToken(params:{platform:\"web\",playerType:\"site\",playerBackend:\"mediaplayer\"}){ signature value } videoQualities{ frameRate quality sourceURL } } }",
        variables: { slug }
      })
    }, TWITCH_RESOLVE_TIMEOUT_MS);

    if (!res.ok) {
      console.error("[video] twitch gql failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json();
    const clip = json?.data?.clip;
    const token = clip?.playbackAccessToken;
    const qualities: any[] = (clip?.videoQualities ?? []).filter((q: any) => q?.sourceURL);
    if (!token?.signature || !token?.value || qualities.length === 0) {
      console.error("[video] twitch gql returned no playable clip:", JSON.stringify(json).slice(0, 300));
      return null;
    }
    // Prefer 720p or lower to keep the payload small for the video model.
    qualities.sort((a, b) => Number(b.quality) - Number(a.quality));
    const pick = qualities.find((q) => Number(q.quality) <= 720) ?? qualities[qualities.length - 1];
    return `${pick.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
  } catch (err) {
    console.error("[video] twitch resolve threw:", String(err));
    return null;
  }
}

async function resolveVideoUrl(url: string): Promise<string | null> {
  if (isDirectVideoUrl(url)) return url;
  const slug = twitchClipSlug(url);
  return slug ? resolveTwitchClipUrl(slug) : null;
}

type VideoPassResult = {
  submitted: number;
  analysis: {
    description: string;
    model: string;
    usage: InferResult["usage"];
    video_count: number;
  } | null;
};

// Factual description only, same contract as the image pass. Runs against the
// OpenRouter video pool directly (Groq and the paid tiers can't take video).
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
  if (submitted === 0) return { submitted: 0, analysis: null };

  const resolved = (await Promise.all(candidates.map((e) => resolveVideoUrl(e.url))))
    .filter((u): u is string => Boolean(u));
  if (resolved.length === 0) return { submitted, analysis: null };

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
            ...resolved.map((url) => ({ type: "video_url", video_url: { url } }))
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
    return { submitted, analysis: null };
  }

  return {
    submitted,
    analysis: {
      description: data.response,
      model: data.model,
      usage: data.usage ?? null,
      video_count: resolved.length
    }
  };
}
"""
edits.append((1, P(r"""
const MAX_EVIDENCE_IMAGES = 4;
"""), P(VIDEO_HELPERS)))

# 4. handleSteward: run image + video passes in parallel ---------------------
edits.append((1, P(r"""
  let imageAnalysis = null;
  if (imageUrls.length > 0) {
    imageAnalysis = await describeEvidenceImages(
      imageUrls,
      `${incident.incident_type} incident, lap ${incident.lap ?? "?"}`,
      env
    );
  }
"""), P(r"""
  const incidentContext = `${incident.incident_type} incident, lap ${incident.lap ?? "?"}`;
  const [imageAnalysis, videoPass] = await Promise.all([
    imageUrls.length > 0
      ? describeEvidenceImages(imageUrls, incidentContext, env)
      : Promise.resolve(null),
    analyseVideoEvidence(allEvidence, incidentContext, env)
  ]);
""")))

# 5. Prompt: add video description -------------------------------------------
edits.append((1, P(r"""
  if (incident.ticket_transcript) {
"""), P(r"""
  if (videoPass.analysis) {
    promptParts.push(`VIDEO EVIDENCE DESCRIPTION (from video pass, observable facts only):\n${videoPass.analysis.description}`);
  } else if (videoPass.submitted > 0) {
    promptParts.push(`Note: ${videoPass.submitted} evidence video(s) were submitted but could not be analyzed. Do not guess what they show.`);
  }

  if (incident.ticket_transcript) {
""")))

# 6. Response: video_analysis meta --------------------------------------------
edits.append((1, P(r"""
  const imageAnalysisMeta = imageAnalysis
"""), P(r"""
  const videoAnalysisMeta = videoPass.analysis
    ? { model: videoPass.analysis.model, usage: videoPass.analysis.usage, video_count: videoPass.analysis.video_count }
    : null;

  const imageAnalysisMeta = imageAnalysis
""")))

edits.append((2, P(r"""
      image_analysis: imageAnalysisMeta,
"""), P(r"""
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
""")))

# ---------------------------------------------------------------------------
for i, (count, old, _new) in enumerate(edits, 1):
    found = src.count(old)
    if found != count:
        print(f"ABORT: edit {i} expected {count} match(es), found {found}. Nothing written.")
        print("Anchor was:\n" + old)
        sys.exit(1)

for _count, old, new in edits:
    src = src.replace(old, new)

if crlf:
    src = src.replace("\n", "\r\n")
open(path, "w", encoding="utf-8", newline="").write(src)
print(f"Patched {path} ({len(edits)} edits).")
