import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// A short spoken command is a few hundred KB at most. Cap uploads so a
// signed-in account can't push huge files through the Groq key.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

// Best-effort per-user limit (in memory, so per server instance). Stops a loop
// from one signed-in account running up the Groq bill; not a hard cap.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 15;
const hits = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_CALLS) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

export async function POST(req: NextRequest) {
  // Require a signed-in user. Without this the route was open to anyone and
  // billed every request to GROQ_API_KEY.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (rateLimited(session.user.userId)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a minute.' }, { status: 429 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'GROQ_API_KEY is not configured on the server' },
      { status: 500 }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const audio = formData.get('audio') as File | null;
  if (!audio) {
    return NextResponse.json({ error: 'audio file is required' }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'audio file too large' }, { status: 413 });
  }

  const groqForm = new FormData();
  groqForm.append('file', audio, audio.name || 'command.webm');
  groqForm.append('model', 'whisper-large-v3-turbo');
  groqForm.append('response_format', 'json');

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: groqForm,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[voice/transcribe]', res.status, errText);
    return NextResponse.json(
      { error: `Transcription failed (${res.status})` },
      { status: 502 }
    );
  }

  const data = await res.json();
  return NextResponse.json({ text: data.text ?? '' });
}
