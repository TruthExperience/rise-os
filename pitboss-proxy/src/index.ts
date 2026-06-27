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

// ─── /steward endpoint ────────────────────────────────────────────────────────

app.post('/steward', async (c) => {
  const { incident, regulations = [], league = 'AWC' } = await c.req.json();

  const regsBlock = regulations.length > 0
    ? regulations.map((r: any) => `Article ${r.article_number} — ${r.title}:\n${r.body}`).join('\n\n')
    : 'No specific regulations provided. Apply standard racing conduct rules.';

  const system = `You are an impartial racing steward AI for ${league}.
Return ONLY valid JSON — no markdown, no preamble.
Shape: { "verdict": "guilty"|"not_guilty"|"inconclusive", "confidence": "high"|"medium"|"low", "reasoning": string, "cited_articles": string[], "pp_recommendation": {"min": number, "max": number}, "mitigating_factors": string[], "aggravating_factors": string[], "steward_notes": string }`;

  const prompt = `INCIDENT: ${incident.incident_type} | TRACK: ${incident.track ?? 'Unknown'} | LAP: ${incident.lap ?? '?'}
ACCUSED: ${incident.accused_username ?? 'Unknown'}
DESCRIPTION: ${incident.description}
REGULATIONS:\n${regsBlock}`;

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

  try {
    const raw = data.response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const suggestion = JSON.parse(raw);
    return Response.json({
      ...data,
      league,
      suggestion,
      disclaimer: 'AI suggestion only. Human steward decision required.',
    });
  } catch {
    return Response.json({
      ...data,
      league,
      suggestion: { verdict: 'inconclusive', confidence: 'low', parse_error: true, raw: data.response },
      disclaimer: 'AI suggestion only. Human steward decision required.',
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
