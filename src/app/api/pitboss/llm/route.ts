import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'crypto';
import { pbInfer, pbSteward, type RuleArticle } from '@/lib/pitboss-llm';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Server-to-server callers (steward route, Discord steward command) have no
// browser session, so they authenticate with the shared PITBOSS_INTERNAL_KEY
// sent as X-PitBoss-Key. Everyone else must be signed in.
function hasValidInternalKey(req: NextRequest): boolean {
  const expected = process.env.PITBOSS_INTERNAL_KEY;
  const provided = req.headers.get('x-pitboss-key');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Best-effort per-user limit (in memory, so it is per server instance, not
// global). It stops a tight loop from one signed-in user; it is not a hard cap.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 20;
const rateHits = new Map<string, number[]>();

function rateLimited(userKey: string): boolean {
  const now = Date.now();
  const hits = (rateHits.get(userKey) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_CALLS) {
    rateHits.set(userKey, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(userKey, hits);
  if (rateHits.size > 5000) {
    for (const [k, v] of rateHits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateHits.delete(k);
    }
  }
  return false;
}

// Actions a signed-in browser user may call. certgen and steward are
// server-to-server only (Discord steward command, rulebook tooling) and need
// the internal key; no page calls them directly.
const USER_ACTIONS = new Set(['infer', 'reg_qa', 'comparison_bias']);
const USER_MODES = new Set(['fast', 'primary', 'quick', 'vision']);
const MAX_USER_TOKENS = 1024;
const MAX_TEXT = 8000;

export async function POST(req: NextRequest) {
  const internal = hasValidInternalKey(req);
  let userKey: string | null = null;
  if (!internal) {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    userKey = session.user.userId;
    if (rateLimited(userKey)) {
      return NextResponse.json({ error: 'Too many requests. Please wait a minute.' }, { status: 429 });
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const { action, ...payload } = body ?? {};

    if (!action) {
      return NextResponse.json({ error: 'action required' }, { status: 400 });
    }

    if (!internal && !USER_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action === 'infer') {
      if (internal) {
        const result = await pbInfer(payload);
        return NextResponse.json(result);
      }
      // Signed-in users get a bounded pass-through: only these fields, an
      // allowed model mode, a token ceiling, and capped text. Without this the
      // route was an open general-purpose LLM proxy billed to the app.
      const { prompt, system, messages, mode, max_tokens, temperature } = payload;
      if (mode != null && !USER_MODES.has(mode)) {
        return NextResponse.json({ error: 'mode not allowed' }, { status: 400 });
      }
      if (prompt != null && (typeof prompt !== 'string' || prompt.length > MAX_TEXT)) {
        return NextResponse.json({ error: 'prompt too long' }, { status: 400 });
      }
      if (system != null && (typeof system !== 'string' || system.length > MAX_TEXT)) {
        return NextResponse.json({ error: 'system too long' }, { status: 400 });
      }
      if (messages != null) {
        if (!Array.isArray(messages) || messages.length > 30) {
          return NextResponse.json({ error: 'messages must be an array of at most 30' }, { status: 400 });
        }
        let textChars = 0;
        for (const m of messages) {
          if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
            return NextResponse.json({ error: 'invalid message role' }, { status: 400 });
          }
          if (typeof m.content === 'string') textChars += m.content.length;
          else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part?.type === 'text' && typeof part.text === 'string') textChars += part.text.length;
            }
          }
        }
        if (textChars > MAX_TEXT * 4) {
          return NextResponse.json({ error: 'messages too long' }, { status: 400 });
        }
      }
      const result = await pbInfer({
        prompt,
        system,
        messages,
        mode,
        max_tokens: Math.min(Number.isFinite(Number(max_tokens)) ? Number(max_tokens) : MAX_USER_TOKENS, MAX_USER_TOKENS),
        temperature: Number.isFinite(Number(temperature)) ? Math.min(Math.max(Number(temperature), 0), 1) : undefined,
      });
      return NextResponse.json(result);
    }

    if (action === 'steward') {
      const { incident, league = 'AWC', fetch_regulations = true } = payload;

      if (!incident) {
        return NextResponse.json({ error: 'incident required' }, { status: 400 });
      }

      // The incident always carries its own league_id (set at creation
      // time in pitboss.incidents). This is the source of truth for
      // scoping regulations — `league` above is just a display label
      // passed through to the LLM prompt, not a filter key.
      const leagueId: string | undefined = incident.league_id ?? payload.league_id;

      let regulations: RuleArticle[] = [];

      if (fetch_regulations && incident.incident_type) {
        if (!leagueId) {
          console.error(
            '[pitboss/llm] steward action called without incident.league_id — regulations cannot be safely scoped, skipping fetch'
          );
        } else {
          const { data, error } = await supabase
            .schema('pitboss')
            .from('rule_articles')
            .select('article_number, title, body, category, league_id, rule_book_id')
            .eq('active', true)
            .eq('league_id', leagueId)
            .or('category.eq.sporting,category.eq.penalties,category.eq.governance')
            .limit(10);

          if (error) {
            console.error('[pitboss/llm] rule_articles fetch failed:', error.message);
          } else if (data) {
            regulations = data as RuleArticle[];
          }
        }
      }

      const result = await pbSteward(incident, regulations, league);
      return NextResponse.json(result);
    }

    if (action === 'reg_qa') {
      const { question, league = 'AWC', league_id } = payload;

      if (!question || typeof question !== 'string') {
        return NextResponse.json({ error: 'question required' }, { status: 400 });
      }
      if (question.length > 1000) {
        return NextResponse.json({ error: 'question too long (max 1000 characters)' }, { status: 400 });
      }
      // Without a league_id the lookup falls back to every league's rules.
      if (!internal && !league_id) {
        return NextResponse.json({ error: 'league_id required' }, { status: 400 });
      }

      let articlesQuery = supabase
        .schema('pitboss')
        .from('rule_articles')
        .select('article_number, title, body, category')
        .eq('active', true)
        .limit(30);

      if (league_id) {
        articlesQuery = articlesQuery.eq('league_id', league_id);
      } else {
        console.error(
          '[pitboss/llm] reg_qa action called without league_id — falling back to unscoped regulations'
        );
      }

      const { data: articles } = await articlesQuery;

      const regsContext = articles && articles.length > 0
        ? articles.map((a) => `[${a.article_number}] ${a.title}: ${a.body}`).join('\n\n')
        : 'No regulations available.';

      const result = await pbInfer({
        mode: 'fast',
        system: `You are PitBoss AI, the regulations assistant for ${league}.
Answer questions about racing regulations clearly and accurately, citing specific article numbers.
Base your answers only on the regulations provided. If something isn't covered, say so.
Be concise and direct.`,
        prompt: `REGULATIONS:\n${regsContext}\n\nQUESTION: ${question}`,
        max_tokens: 512,
        temperature: 0.2,
      });

      return NextResponse.json(result);
    }

    if (action === 'certgen') {
      const { rule_book_id, role_code, count = 5 } = payload;

      if (!rule_book_id) {
        return NextResponse.json({ error: 'rule_book_id required' }, { status: 400 });
      }

      const { data: articles } = await supabase
        .schema('pitboss')
        .from('rule_articles')
        .select('article_number, title, body')
        .eq('rule_book_id', rule_book_id)
        .eq('active', true)
        .limit(20);

      if (!articles || articles.length === 0) {
        return NextResponse.json(
          { error: 'No articles found for this rule book' },
          { status: 404 }
        );
      }

      const regsContext = articles
        .map((a) => `[${a.article_number}] ${a.title}: ${a.body}`)
        .join('\n\n');

      const result = await pbInfer({
        mode: 'certgen',
        system: `You are PitBoss AI generating certification exam questions for ${role_code || 'driver'} certification.
Generate exactly ${count} multiple choice questions based on the regulations provided.
Each question must have 4 options (A, B, C, D) with exactly one correct answer.
Output valid JSON only — an array of question objects.
Format: [{ "question": "...", "options": { "A": "...", "B": "...", "C": "...", "D": "..." }, "correct_answer": "A", "explanation": "...", "article_reference": "..." }]`,
        prompt: `REGULATIONS:\n${regsContext}\n\nGenerate ${count} certification questions now. Output JSON array only.`,
        max_tokens: 2048,
        temperature: 0.5,
      });

      let questions;
      try {
        questions = JSON.parse(result.response.replace(/```json|```/g, '').trim());
      } catch {
        questions = { raw: result.response, parse_error: true };
      }

      return NextResponse.json({
        questions,
        model: result.model,
        provider: result.provider,
      });
    }

    if (action === 'comparison_bias') {
      const {
        comparison_drivers,
        car_feel_notes,
        notes,
        car_feel_preference,
        known_param_keys,
      } = payload;

      if (!comparison_drivers && !car_feel_notes) {
        return NextResponse.json(
          { error: 'comparison_drivers or car_feel_notes required' },
          { status: 400 }
        );
      }
      if (!Array.isArray(known_param_keys) || known_param_keys.length === 0) {
        return NextResponse.json({ error: 'known_param_keys required' }, { status: 400 });
      }
      // known_param_keys is pasted into the system prompt, so keep it to plain
      // identifiers, and cap the free-text fields.
      if (
        known_param_keys.length > 100 ||
        !known_param_keys.every((k: unknown) => typeof k === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(k))
      ) {
        return NextResponse.json({ error: 'known_param_keys must be up to 100 plain identifiers' }, { status: 400 });
      }
      for (const v of [comparison_drivers, car_feel_notes, notes, car_feel_preference]) {
        if (v != null && (typeof v !== 'string' || v.length > 2000)) {
          return NextResponse.json({ error: 'text fields must be strings under 2000 characters' }, { status: 400 });
        }
      }

      // Translates a driver's freeform "I drive like X, defend like Y"
      // profile into small, directional setup-param weights — the same
      // { param_key, delta, confidence, reasoning } shape the existing
      // /setup-feedback worker path already uses for post-race feedback,
      // reused here for consistency even though this is a distinct
      // one-time-per-profile-edit generation, not a per-recommendation
      // adjustment. Weights are a fraction of that param's full range
      // (like TEAM_TRAIT_PARAM_MAP/CAR_FEEL_PARAM_MAP in setup-engine.ts),
      // not an absolute in-game unit — kept small since this stacks on
      // top of the driver's direct car_feel_preference bias, not in place
      // of it.
      const result = await pbInfer({
        mode: 'fast',
        system: `You are PitBoss AI, translating an F1 25 driver's stated influences and feel preferences into small setup-parameter bias weights.

Valid param keys (only use these, exactly as spelled): ${known_param_keys.join(', ')}

Each weight is a DIRECTIONAL FRACTION in the range -0.15 to 0.15, not a real setup value — it represents "push this param this much toward its max (positive) or min (negative) end of its own range, on top of whatever baseline setup is already generated." Stay conservative: most drivers should get 3-6 weighted params, not all of them, and most weights should sit under 0.08 unless the driver's notes are very specific and strong about a characteristic.

The driver already has a separate direct car_feel_preference of "${car_feel_preference ?? 'not set'}" which already biases the setup — do not duplicate that signal, only add what the comparison drivers / freetext notes suggest ON TOP of it (e.g. a specific real driver's known racing style, tyre management habits, or braking/defending characteristics that aren't already implied by the car_feel_preference alone).

Output valid JSON only — an array of objects, no markdown fencing, no commentary.
Format: [{ "param_key": "...", "delta": 0.05, "confidence": "low"|"medium"|"high", "reasoning": "..." }]
If nothing in the notes suggests a meaningful bias beyond the existing car_feel_preference, output an empty array: []`,
        prompt: `Comparison drivers: ${comparison_drivers ?? 'none given'}
Car feel notes: ${car_feel_notes ?? 'none given'}
Additional notes: ${notes ?? 'none given'}

Generate the bias weight array now. Output JSON array only.`,
        max_tokens: 768,
        temperature: 0.3,
      });

      let adjustments;
      try {
        adjustments = JSON.parse(result.response.replace(/```json|```/g, '').trim());
      } catch {
        return NextResponse.json({
          adjustments: [],
          raw: result.response,
          parse_error: true,
          model: result.model,
          provider: result.provider,
        });
      }

      return NextResponse.json({
        adjustments,
        model: result.model,
        provider: result.provider,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[pitboss/llm]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // Same gate as POST: internal key or a signed-in session.
  if (!hasValidInternalKey(req)) {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const { pbHealth } = await import('@/lib/pitboss-llm');
    const health = await pbHealth();
    return NextResponse.json(health);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
