// pitboss-proxy/index.js  (Cloudflare Worker — vanilla JS, no deps, Quick Edit compatible)

// ─── Model registry ───────────────────────────────────────────────────────────
// Ordered by quality per task. All :free. Paid models only appear in PAID_FALLBACK.

const MODELS = {

  // General purpose — quality ordered
  general: [
    'qwen/qwen3-235b-a22b:free',          // #1 open-weight general reasoning
    'meta-llama/llama-4-maverick:free',    // strong, vision-capable
    'deepseek/deepseek-chat-v3-0324:free', // fast, balanced
    'google/gemma-3-27b-it:free',          // reliable fallback
    'meta-llama/llama-4-scout:free',       // fastest free option
    'meta-llama/llama-3.3-70b-instruct:free',
    'openrouter/free',                     // auto-router last resort
  ],

  // Reasoning / steward — deep thinking models
  reasoning: [
    'deepseek/deepseek-r1:free',           // #1 open reasoning
    'deepseek/deepseek-r1-0528:free',      // latest R1
    'qwen/qwen3-235b-a22b:free',           // dual-mode thinking
    'nvidia/nemotron-3-ultra-253b-v1:free',// 1M context reasoning
    'zhipu-ai/glm-4.5-air:free',           // GLM family, strong reasoning
    'meta-llama/llama-4-maverick:free',
    'openrouter/free',
  ],

  // Coding
  coding: [
    'qwen/qwen3-coder-480b-a35b-instruct:free', // #1 free coding
    'deepseek/deepseek-r1:free',                 // strong coder
    'qwen/qwen3-235b-a22b:free',
    'meta-llama/llama-4-maverick:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'openrouter/free',
  ],

  // Vision — image evidence only
  vision: [
    'meta-llama/llama-4-maverick:free',
    'google/gemma-3-27b-it:free',
    'nvidia/nemotron-nano-vl-12b-v2:free',
    'moonshotai/kimi-vl-a3b-thinking:free',
  ],

  // Video — genuine video_url support, not just image frames.
  // NOTE: verify this model ID and free-tier availability against
  // OpenRouter's live model list before relying on it — video support
  // moves fast and per-model, unlike the stable image-vision pool above.
  video: [
    'google/gemma-4-26b-a4b-it:free',
  ],

  // Fast / low latency — shorter context, quicker response
  fast: [
    'meta-llama/llama-4-scout:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'google/gemma-3-27b-it:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'openrouter/free',
  ],

};

// Only used if ALL free models fail (not currently invoked below — kept for parity
// with the original file; wire in a paid-fallback call here if/when needed).
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Evidence-image / evidence-video helpers ──────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;
// Direct video FILE urls only — e.g. Discord CDN attachments
// (cdn.discordapp.com/attachments/.../clip.mp4). Webpage links to
// YouTube/Streamable/Medal.tv do NOT match this and are not resolvable
// to a raw video file without a separate scraping step — those still
// fall through to text-only treatment below, same as before.
const VIDEO_EXT_RE = /\.(mp4|mov|webm)(\?.*)?$/i;

function isLikelyImageUrl(url) {
  return IMAGE_EXT_RE.test(url.split('?')[0]);
}

function isLikelyVideoFileUrl(url) {
  return VIDEO_EXT_RE.test(url.split('?')[0]);
}

// Evidence images/videos add real latency/cost per request, and free
// models have modest limits — cap how many go in per pass.
const MAX_EVIDENCE_IMAGES = 4;
const MAX_EVIDENCE_VIDEOS = 2;

// ─── Mode → pool mapping ──────────────────────────────────────────────────────

function poolForMode(mode, hasImage) {
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

// ─── Core inference with waterfall ───────────────────────────────────────────
// Returns a plain object (not a Response) so callers can inspect/transform
// the result before deciding how to respond.

async function inferWithWaterfall(pool, body, openrouterKey) {
  const errors = [];

  for (const model of pool) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openrouterKey}`,
          'HTTP-Referer': 'https://rise-os.app',
          'X-Title': 'PitBoss Internal LLM',
        },
        body: JSON.stringify({ ...body, model }),
      });

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
        provider: 'openrouter:free',
        free: true,
        usage: data.usage ?? null,
      };

    } catch (err) {
      errors.push(`${model}: ${String(err)}`);
      continue;
    }
  }

  // All free failed — return error list for client to handle paid fallback
  return { error: 'all_free_models_failed', tried: errors };
}

// ─── Image-description pass (used by /steward) ───────────────────────────────
// Pass 1a: ask a vision model to describe what's visible in each image,
// purely factually — no verdict, no rule interpretation. Keeps the
// vision model in its lane and hands the reasoning model clean text
// it can actually reason well over.

async function describeEvidenceImages(imageUrls, incidentContext, openrouterKey) {
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
    openrouterKey
  );

  if (data.error) return null; // caller falls back to text-only reasoning

  return {
    description: data.response,
    model: data.model,
    usage: data.usage ?? null,
  };
}

// ─── Video-description pass (used by /steward) ────────────────────────────────
// Pass 1b: same idea as the image pass above, but for direct video file
// URLs using OpenRouter's video_url content type. Only fires for URLs
// that are actual video files (Discord CDN attachments, etc.) — webpage
// links to YouTube/Streamable/Medal.tv aren't resolvable here and stay
// text-only, same as before this change.

async function describeEvidenceVideos(videoUrls, incidentContext, openrouterKey) {
  const system = `You are a factual video-description assistant for motorsport incident evidence.
Describe ONLY what is visibly happening across the clip — car positions and movement, contact, track position, timing/HUD overlays if visible, any visible damage, and how the situation develops over the duration of the clip.
Do NOT render a verdict, cite rules, or speculate about intent. Stick to what's observable.
If a video fails to load or is unrelated to racing, say so plainly instead of guessing.`;

  const prompt = `INCIDENT CONTEXT (for reference only, not for you to judge): ${incidentContext}

Describe what happens in the attached video clip(s), in order, including how the situation develops over time.`;

  const data = await inferWithWaterfall(
    MODELS.video,
    {
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...videoUrls.map((url) => ({ type: 'video_url', video_url: { url } })),
          ],
        },
      ],
      max_tokens: 900,
      temperature: 0.1,
    },
    openrouterKey
  );

  if (data.error) return null; // caller falls back to text-only reasoning

  return {
    description: data.response,
    model: data.model,
    usage: data.usage ?? null,
  };
}

// ─── Route handlers ────────────────────────────────────────────────────────────

async function handleInfer(request, env) {
  const body = await request.json();
  const mode = body.mode ?? 'primary';
  const hasImage = Array.isArray(body.messages) &&
    body.messages.some((m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'image_url')
    );

  const pool = poolForMode(mode, hasImage);
  const inferBody = {
    messages: body.messages ?? [
      ...(body.system ? [{ role: 'system', content: body.system }] : []),
      ...(body.prompt ? [{ role: 'user', content: body.prompt }] : []),
    ],
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature ?? 0.3,
  };

  const data = await inferWithWaterfall(pool, inferBody, env.OPENROUTER_API_KEY);
  if (data.error) return jsonResponse(data, 503);
  return jsonResponse(data);
}

async function handleSteward(request, env) {
  const { incident, regulations = [], league = 'AWC' } = await request.json();

  const regsBlock = regulations.length > 0
    ? regulations.map((r) => `Article ${r.article_number} — ${r.title}:\n${r.body}`).join('\n\n')
    : 'No specific regulations provided. Apply standard racing conduct rules.';

  // incident.reporter_evidence / incident.accused_evidence are arrays of
  // { url, label, source } objects (upload vs link), not flat URL
  // strings — steward.ts's getIncidentEvidence resolves signed URLs for
  // Supabase-stored uploads before sending these over.
  const reporterEvidence = incident.reporter_evidence ?? [];
  const accusedEvidence = incident.accused_evidence ?? [];
  const allEvidence = [...reporterEvidence, ...accusedEvidence];

  const imageEvidence = allEvidence
    .filter((e) => isLikelyImageUrl(e.url))
    .slice(0, MAX_EVIDENCE_IMAGES);
  const imageUrls = imageEvidence.map((e) => e.url);

  const videoEvidence = allEvidence
    .filter((e) => isLikelyVideoFileUrl(e.url))
    .slice(0, MAX_EVIDENCE_VIDEOS);
  const videoUrls = videoEvidence.map((e) => e.url);

  // Evidence that's neither an image nor a directly-analyzable video file
  // (e.g. YouTube/Streamable/Medal.tv page links) — still noted for the
  // reasoning model as a link, same as the original behavior.
  const unanalyzedLinkCount = allEvidence.length - imageUrls.length - videoUrls.length;

  const incidentContext = `${incident.incident_type} incident, lap ${incident.lap ?? '?'}`;

  // Passes 1a/1b — describe images and videos, if any. A failure in
  // either just means that section is omitted from the verdict pass
  // rather than failing the whole request.
  let imageAnalysis = null;
  if (imageUrls.length > 0) {
    imageAnalysis = await describeEvidenceImages(imageUrls, incidentContext, env.OPENROUTER_API_KEY);
  }

  let videoAnalysis = null;
  if (videoUrls.length > 0) {
    videoAnalysis = await describeEvidenceVideos(videoUrls, incidentContext, env.OPENROUTER_API_KEY);
  }

  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON — no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }
Base your verdict on ALL evidence provided — the reporter's account, the accused driver's defense (if any), evidence links, the full ticket conversation transcript if included, and the image/video descriptions if provided. Those descriptions were produced by separate vision/video passes and reflect only what is visibly observable — treat them as factual accounts, not a verdict.`;

  // Build the prompt incrementally so sections with no data (no defense
  // yet, no transcript yet, no evidence) are simply omitted rather than
  // sent as "undefined" or empty noise.
  const promptParts = [
    `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? 'Unknown'} | LAP: ${incident.lap ?? '?'}`,
    `ACCUSED: ${incident.accused_username ?? 'Unknown'}`,
    `REPORTER DESCRIPTION: ${incident.description}`,
  ];

  if (reporterEvidence.length > 0) {
    promptParts.push(
      `REPORTER EVIDENCE LINKS:\n${reporterEvidence.map((e) => `- ${e.label ? `${e.label}: ` : ''}${e.url}`).join('\n')}`
    );
  }

  if (incident.accused_response) {
    promptParts.push(`ACCUSED DRIVER'S DEFENSE: ${incident.accused_response}`);
  }

  if (accusedEvidence.length > 0) {
    promptParts.push(
      `ACCUSED EVIDENCE LINKS:\n${accusedEvidence.map((e) => `- ${e.label ? `${e.label}: ` : ''}${e.url}`).join('\n')}`
    );
  }

  if (imageAnalysis) {
    promptParts.push(`IMAGE EVIDENCE DESCRIPTION (from vision pass):\n${imageAnalysis.description}`);
  } else if (imageUrls.length > 0) {
    promptParts.push(`Note: ${imageUrls.length} evidence image(s) were submitted but could not be analyzed (link may have expired or failed to load).`);
  }

  if (videoAnalysis) {
    promptParts.push(`VIDEO EVIDENCE DESCRIPTION (from video pass):\n${videoAnalysis.description}`);
  } else if (videoUrls.length > 0) {
    promptParts.push(`Note: ${videoUrls.length} evidence video(s) were submitted but could not be analyzed (link may have expired or failed to load).`);
  }

  if (unanalyzedLinkCount > 0) {
    promptParts.push(`Note: ${unanalyzedLinkCount} additional evidence link(s) were submitted as webpage links (e.g. YouTube/Streamable/Medal.tv) rather than direct files, and were not visually analyzed — only the URL itself was available.`);
  }

  if (incident.ticket_transcript) {
    // Cap this — a long back-and-forth shouldn't crowd out the
    // regulations block or blow the model's context budget.
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
    env.OPENROUTER_API_KEY
  );

  if (data.error) return jsonResponse(data, 503);

  const imageAnalysisMeta = imageAnalysis
    ? { model: imageAnalysis.model, usage: imageAnalysis.usage, image_count: imageUrls.length }
    : null;

  const videoAnalysisMeta = videoAnalysis
    ? { model: videoAnalysis.model, usage: videoAnalysis.usage, video_count: videoUrls.length }
    : null;

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const suggestion = JSON.parse(raw);
    return jsonResponse({
      ...data,
      league,
      suggestion,
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  } catch {
    return jsonResponse({
      ...data,
      league,
      suggestion: { verdict: 'inconclusive', confidence: 'low', parse_error: true, raw: data.response },
      image_analysis: imageAnalysisMeta,
      video_analysis: videoAnalysisMeta,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  }
}

async function handleSetupFeedback(request, env) {
  const { feedback_text, known_param_keys = [], context = {}, league = 'AWC' } = await request.json();

  if (!feedback_text || known_param_keys.length === 0) {
    return jsonResponse({ error: 'feedback_text and known_param_keys are required' }, 400);
  }

  const paramKeysBlock = known_param_keys.map((k) => `- ${k}`).join('\n');

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
    env.OPENROUTER_API_KEY
  );

  if (data.error) return jsonResponse(data, 503);

  const disclaimer = 'AI-generated suggestion. Review before applying to setup.';

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(raw);

    const validKeys = new Set(known_param_keys);
    parsed.adjustments = (parsed.adjustments ?? []).filter((a) =>
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

async function handleHealth(request, env) {
  // Quick probe of the top model from each pool
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Auth — applies to every route below
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

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'internal_error', message: String(err) }, 500);
    }
  },
};
