// ADDED — bounds how long any single model attempt can hang before the
// waterfall moves on. Without this, one unresponsive free model (as
// opposed to one that fails fast with 429/503) can silently eat the
// entire per-model budget and leave no time for the rest of the pool
// or paid fallback — which then makes the client-side timeout in
// pitboss-llm.ts the ONLY thing standing between a hung model and a
// dead Vercel function, instead of a second line of defense.
const PER_MODEL_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function inferWithWaterfall(pool, body, env) {
  const openrouterKey = env.OPENROUTER_API_KEY ?? env;
  const errors = [];

  for (const model of pool) {
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
      }, PER_MODEL_TIMEOUT_MS); // ADDED

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
      // ADDED — label timeout distinctly from other thrown errors so
      // /health / logs can tell "model hung" apart from "model errored".
      if (err && err.name === 'AbortError') {
        errors.push(`${model}: timed out after ${PER_MODEL_TIMEOUT_MS}ms`);
      } else {
        errors.push(`${model}: ${String(err)}`);
      }
      continue;
    }
  }

  // All free failed — try paid fallback if env has keys configured, and
  // env itself was passed (not just a bare key string, as some internal
  // callers still do).
  if (env && typeof env === 'object' && env.OPENROUTER_API_KEY) {
    const paidResult = await callPaidFallback(body, env);
    if (paidResult) return paidResult;
  }

  return { error: 'all_free_models_failed', tried: errors };
}
