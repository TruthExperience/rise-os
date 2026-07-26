// pitboss-proxy/src/index.ts  (Cloudflare Worker)

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors());

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.use('*', async (c, next) => {
  const key = c.req.header('X-PitBoss-Key');
  if (key !== c.env.PITBOSS_INTERNAL_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

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
    'zhipu-ai/glm-4.5-air:free',          // GLM family, strong reasoning
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

  // Vision
  vision: [
    'meta-llama/llama-4-maverick:free',
    'google/gemma-3-27b-it:free',
    'nvidia/nemotron-nano-vl-12b-v2:free',
    'moonshotai/kimi-vl-a3b-thinking:free',
  ],

  // Fast / low latency — shorter context, quicker response
  fast: [
    'meta-llama/llama-4-scout:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'google/gemma-3-27b-it:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'openrouter/free',
  ],

} as const;

// Only used if ALL free models fail
const PAID_FALLBACK = [
  { model: 'anthropic/claude-sonnet-4-6', key: 'ANTHROPIC_KEY' },
  { model: 'openai/gpt-4o-mini',          key: 'OPENAI_KEY'    },
];

// ─── Evidence-image helpers ───────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

function isLikelyImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url.split('?')[0]);
}

// Evidence images add real latency/cost per request, and free vision
// models have modest limits — cap how many go in as image blocks.
const MAX_EVIDENCE_IMAGES = 4;

// ─── Mode → pool mapping ──────────────────────────────────────────────────────

type Mode = 'fast' | 'primary' | 'reasoning' | 'certgen' | 'quick' | 'steward' | 'coding' | 'vision';

function poolForMode(mode: Mode, hasImage: boolean): readonly string[] {
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

async function inferWithWaterfall(
  pool: readonly string[],
  body: object,
  openrouterKey: string
): Promise<Response> {
  const errors: string[] = [];

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

      const data: any = await res.json();
      return Response.json({
        response: data.choices[0].message.content,
        model: data.model ?? model,
        provider: 'openrouter:free',
        free: true,
        usage: data.usage ?? null,
      });

    } catch (err) {
      errors.push(`${model}: ${String(err)}`);
      continue;
    }
  }

  // All free failed — log and return error list for client to handle paid fallback
  return Response.json({
    error: 'all_free_models_failed',
    tried: errors,
  }, { status: 503 });
}

// ─── /infer endpoint ──────────────────────────────────────────────────────────

app.post('/infer', async (c) => {
  const body: any = await c.req.json();
  const mode: Mode = body.mode ?? 'primary';
  const hasImage = Array.isArray(body.messages) &&
    body.messages.some((m: any) =>
      Array.isArray(m.content) &&
      m.content.some((p: any) => p.type === 'image_url')
    );

  const pool = poolForMode(mode, hasImage);
  const inferBody = {
    messages: body.messages ?? [
      ...(body.system  ? [{ role: 'system', content: body.system }]  : []),
      ...(body.prompt  ? [{ role: 'user',   content: body.prompt }]  : []),
    ],
    max_tokens:  body.max_tokens  ?? 1024,
    temperature: body.temperature ?? 0.3,
  };

  return inferWithWaterfall(pool, inferBody, c.env.OPENROUTER_KEY);
});

// ─── Image-description pass (used by /steward) ───────────────────────────────

type ImageDescriptionResult = {
  description: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
};

// Pass 1: ask a vision model to describe what's visible in each image,
// purely factually — no verdict, no rule interpretation. Keeps the
// vision model in its lane and hands the reasoning model clean text
// it can actually reason well over.
async function describeEvidenceImages(
  imageUrls: string[],
  incidentContext: string,
  openrouterKey: string
): Promise<ImageDescriptionResult | null> {
  const system = `You are a factual image-description assistant for motorsport incident evidence.
Describe ONLY what is visibly happening in the image(s) — car positions, contact, track position, timing/HUD overlays if visible, any visible damage.
Do NOT render a verdict, cite rules, or speculate about intent. Stick to what's observable.
If an image fails to load or is unrelated to racing, say so plainly instead of guessing.`;

  const prompt = `INCIDENT CONTEXT (for reference only, not for you to judge): ${incidentContext}

Describe what's visible in the attached image(s), in order.`;

  const res = await inferWithWaterfall(
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

  const data: any = await res.json();
  if (data.error) return null; // caller falls back to text-only reasoning

  return {
    description: data.response as string,
    model: data.model as string,
    usage: data.usage ?? null,
  };
}

// ─── /steward endpoint ────────────────────────────────────────────────────────

app.post('/steward', async (c) => {
  const { incident, regulations = [], league = 'AWC' } = await c.req.json();

  const regsBlock = regulations.length > 0
    ? regulations.map((r: any) => `Article ${r.article_number} — ${r.title}:\n${r.body}`).join('\n\n')
    : 'No specific regulations provided. Apply standard racing conduct rules.';

  const reporterEvidence: string[] = incident.reporter_evidence_urls ?? [];
  const accusedEvidence: string[] = incident.accused_evidence_urls ?? [];
  const imageUrls = [...reporterEvidence, ...accusedEvidence]
    .filter(isLikelyImageUrl)
    .slice(0, MAX_EVIDENCE_IMAGES);

  // Pass 1 — describe images, if any. A failure here (bad URL, expired
  // Discord CDN link, vision pool down) just means the verdict pass
  // proceeds without image context rather than failing the whole request.
  let imageAnalysis: ImageDescriptionResult | null = null;
  if (imageUrls.length > 0) {
    imageAnalysis = await describeEvidenceImages(
      imageUrls,
      `${incident.incident_type} incident, lap ${incident.lap ?? '?'}`,
      c.env.OPENROUTER_KEY
    );
  }

  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON — no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }
Base your verdict on ALL evidence provided — the reporter's account, the accused driver's defense (if any), evidence links, the full ticket conversation transcript if included, and the image description if provided. The image description was produced by a separate vision pass and reflects only what is visibly observable — treat it as a factual account, not a verdict.`;

  // Build the prompt incrementally so sections with no data (no defense
  // yet, no transcript yet, no evidence) are simply omitted rather than
  // sent as "undefined" or empty noise.
  const promptParts = [
    `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? 'Unknown'} | LAP: ${incident.lap ?? '?'}`,
    `ACCUSED: ${incident.accused_username ?? 'Unknown'}`,
    `REPORTER DESCRIPTION: ${incident.description}`,
  ];

  if (reporterEvidence.length > 0) {
    promptParts.push(`REPORTER EVIDENCE LINKS:\n${reporterEvidence.map((u: string) => `- ${u}`).join('\n')}`);
  }

  if (incident.accused_response) {
    promptParts.push(`ACCUSED DRIVER'S DEFENSE: ${incident.accused_response}`);
  }

  if (accusedEvidence.length > 0) {
    promptParts.push(`ACCUSED EVIDENCE LINKS:\n${accusedEvidence.map((u: string) => `- ${u}`).join('\n')}`);
  }

  if (imageAnalysis) {
    promptParts.push(`IMAGE EVIDENCE DESCRIPTION (from vision pass):\n${imageAnalysis.description}`);
  } else if (imageUrls.length > 0) {
    promptParts.push(`Note: ${imageUrls.length} evidence image(s) were submitted but could not be analyzed (link may have expired or failed to load).`);
  }

  if (incident.ticket_transcript) {
    // Cap this — a long back-and-forth shouldn't crowd out the
    // regulations block or blow the model's context budget.
    const transcript = String(incident.ticket_transcript).slice(0, 6000);
    promptParts.push(`FULL TICKET CONVERSATION TRANSCRIPT:\n${transcript}`);
  }

  promptParts.push(`REGULATIONS:\n${regsBlock}`);

  const prompt = promptParts.join('\n\n');

  const res = await inferWithWaterfall(
    MODELS.reasoning,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    },
    c.env.OPENROUTER_KEY
  );

  const data: any = await res.json();
  if (data.error) return Response.json(data, { status: 503 });

  const imageAnalysisMeta = imageAnalysis
    ? { model: imageAnalysis.model, usage: imageAnalysis.usage, image_count: imageUrls.length }
    : null;

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const suggestion = JSON.parse(raw);
    return Response.json({
      ...data,
      league,
      suggestion,
      image_analysis: imageAnalysisMeta,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  } catch {
    return Response.json({
      ...data,
      league,
      suggestion: { verdict: 'inconclusive', confidence: 'low', parse_error: true, raw: data.response },
      image_analysis: imageAnalysisMeta,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  }
});

// ─── /setup-feedback endpoint ─────────────────────────────────────────────────

app.post('/setup-feedback', async (c) => {
  const { feedback_text, known_param_keys = [], context = {}, league = 'AWC' } = await c.req.json();

  if (!feedback_text || known_param_keys.length === 0) {
    return c.json({ error: 'feedback_text and known_param_keys are required' }, 400);
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

  const res = await inferWithWaterfall(
    MODELS.reasoning,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 1024,
      temperature: 0.2,
    },
    c.env.OPENROUTER_KEY
  );

  const data: any = await res.json();
  if (data.error) return Response.json(data, { status: 503 });

  const disclaimer = 'AI-generated suggestion. Review before applying to setup.';

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(raw);

    const validKeys = new Set(known_param_keys);
    parsed.adjustments = (parsed.adjustments ?? []).filter((a: any) =>
      a && typeof a.param_key === 'string' && validKeys.has(a.param_key) &&
      typeof a.delta === 'number' &&
      ['low', 'medium', 'high'].includes(a.confidence)
    );

    return Response.json({
      ...data,
      league,
      adjustments: parsed.adjustments,
      summary: parsed.summary ?? '',
      disclaimer,
    });
  } catch {
    return Response.json({
      ...data,
      league,
      adjustments: [],
      summary: '',
      raw: data.response,
      parse_error: true,
      disclaimer,
    });
  }
});

// ─── /health endpoint ─────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  // Quick probe of the top model from each pool
  const probes = await Promise.allSettled(
    Object.entries(MODELS).map(async ([pool, models]) => {
      const start = Date.now();
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.OPENROUTER_KEY}`,
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

  return Response.json({
    status: 'ok',
    source: 'pitboss-proxy',
    pools: probes.map(p => p.status === 'fulfilled' ? p.value : { error: String(p.reason) }),
    models: MODELS,
  });
});

export default app;
