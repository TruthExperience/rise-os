import { NextRequest, NextResponse } from 'next/server';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export async function POST(req: NextRequest) {
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
