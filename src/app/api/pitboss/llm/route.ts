import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { pbInfer, pbSteward } from '@/lib/pitboss-llm';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, ...payload } = body;

    if (!action) {
      return NextResponse.json({ error: 'action required' }, { status: 400 });
    }

    if (action === 'infer') {
      const result = await pbInfer(payload);
      return NextResponse.json(result);
    }

    if (action === 'steward') {
      const { incident, league = 'AWC', fetch_regulations = true } = payload;

      if (!incident) {
        return NextResponse.json({ error: 'incident required' }, { status: 400 });
      }

      let regulations: { article_number: string; title: string; body: string }[] = [];

      if (fetch_regulations && incident.incident_type) {
        const { data } = await supabase
          .schema('pitboss')
          .from('rule_articles')
          .select('article_number, title, body, category')
          .eq('active', true)
          .or(`category.eq.sporting,category.eq.penalties,category.eq.governance`)
          .limit(10);

        if (data) regulations = data;
      }

      const result = await pbSteward(incident, regulations, league);
      return NextResponse.json(result);
    }

    if (action === 'reg_qa') {
      const { question, league = 'AWC' } = payload;

      if (!question) {
        return NextResponse.json({ error: 'question required' }, { status: 400 });
      }

      const { data: articles } = await supabase
        .schema('pitboss')
        .from('rule_articles')
        .select('article_number, title, body, chapter')
        .eq('active', true)
        .limit(30);

      const regsContext = articles
        ? articles.map(a => `[${a.article_number}] ${a.title}: ${a.body}`).join('\n\n')
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
        return NextResponse.json({ error: 'No articles found for this rule book' }, { status: 404 });
      }

      const regsContext = articles.map(a => `[${a.article_number}] ${a.title}: ${a.body}`).join('\n\n');

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

      return NextResponse.json({ questions, model: result.model, provider: result.provider });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[pitboss/llm]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { pbHealth } = await import('@/lib/pitboss-llm');
    const health = await pbHealth();
    return NextResponse.json(health);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
