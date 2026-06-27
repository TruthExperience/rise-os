// pitboss-llm.ts — now just a typed client, all logic lives in the worker

const WORKER_URL = process.env.PITBOSS_WORKER_URL || 'https://pitboss-proxy.truthexper.workers.dev';
const INTERNAL_KEY = process.env.PITBOSS_INTERNAL_KEY;
if (!INTERNAL_KEY) throw new Error('PITBOSS_INTERNAL_KEY is not set');

export type LLMMode = 'fast' | 'primary' | 'reasoning' | 'certgen' | 'quick' | 'steward' | 'coding' | 'vision';

export interface InferOptions {
  prompt?:     string;
  system?:     string;
  messages?:   { role: 'user' | 'assistant'; content: string | object[] }[];
  mode?:       LLMMode;
  max_tokens?: number;
  temperature?: number;
}

export interface InferResult {
  response: string;
  model:    string;
  provider: string;
  free:     boolean;
  usage?:   { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

async function workerPost(path: string, body: object): Promise<any> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PitBoss-Key': INTERNAL_KEY!,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PitBoss ${path} error ${res.status}: ${await res.text()}`);
  return res.json();
}

export const pbInfer   = (opts: InferOptions)                          => workerPost('/infer',   { mode: 'primary', max_tokens: 1024, temperature: 0.3, ...opts }) as Promise<InferResult>;
export const pbSteward = (incident: any, regulations: any[], league: string) => workerPost('/steward', { incident, regulations, league });
export const pbHealth  = ()                                            => fetch(`${WORKER_URL}/health`, { headers: { 'X-PitBoss-Key': INTERNAL_KEY! } }).then(r => r.json());
