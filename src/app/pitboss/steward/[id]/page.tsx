'use client';

import { useSession } from 'next-auth/react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

const VERDICT_OPTIONS = ['Guilty', 'Not Guilty', 'Dismissed', 'Noted'];
const PENALTY_OPTIONS = [
  'Time Penalty', 'Grid Penalty', 'Drive-Through',
  'Stop-Go', 'DSQ', 'Warning', 'Points Only',
];

export default function IncidentReviewPage() {
  const { data: session, status } = useSession();
  const router       = useRouter();
  const { id }       = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const league_id    = searchParams.get('league_id');

  const [incident, setIncident]       = useState<any>(null);
  const [loading, setLoading]         = useState(true);
  const [analysing, setAnalysing]     = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [showAI, setShowAI]           = useState(true);

  const [verdict, setVerdict]               = useState('');
  const [penalty, setPenalty]               = useState('');
  const [points, setPoints]                 = useState(0);
  const [notes, setNotes]                   = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login');
  }, [status]);

  useEffect(() => {
    if (id) fetchIncident();
  }, [id]);

  async function fetchIncident() {
    setLoading(true);
    try {
      const res = await fetch(`/api/pitboss/steward/${id}`);
      if (res.ok) {
        const data = await res.json();
        setIncident(data);
        if (data.ai_verdict) {
          setVerdict(data.ai_verdict);
          setPenalty(data.ai_penalty ?? '');
          setPoints(data.ai_points   ?? 0);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function runAI() {
    setAnalysing(true);
    try {
      const res = await fetch(`/api/pitboss/steward/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyse' }),
      });
      if (res.ok) await fetchIncident();
    } finally {
      setAnalysing(false);
    }
  }

  async function resolve() {
    if (!verdict) return;
    setSubmitting(true);
    try {
      const isOverride = incident.ai_verdict && verdict !== incident.ai_verdict;
      await fetch(`/api/pitboss/steward/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:          'resolve',
          verdict,
          penalty,
          penalty_points:  points,
          steward_notes:   notes,
          override_reason: isOverride ? overrideReason : null,
          resolved_by:     (session?.user as any)?.id,
        }),
      });
      router.push(`/pitboss/steward?league_id=${league_id}`);
    } finally {
      setSubmitting(false);
    }
  }

  function acceptAI() {
    if (!incident) return;
    setVerdict(incident.ai_verdict ?? '');
    setPenalty(incident.ai_penalty ?? '');
    setPoints(incident.ai_points   ?? 0);
    setOverrideReason('');
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  if (!incident) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <p className="text-white/40">Incident not found.</p>
      </main>
    );
  }

  const isOverride = incident.ai_verdict && verdict !== incident.ai_verdict;
  const confidence = incident.ai_confidence ? Math.round(incident.ai_confidence * 100) : null;

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <button onClick={() => router.back()} className="text-white/40 text-sm mb-6 flex items-center gap-2">
        ← Back
      </button>

      <h1 className="text-xl font-black text-white mb-1">Incident Review</h1>
      <p className="text-white/30 text-[10px] uppercase tracking-widest mb-6">
        {incident.status === 'resolved' ? '✅ Resolved' : '🔴 Open'}
      </p>

      {/* Incident details */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-4 mb-4">
        <p className="text-white/30 text-[10px] uppercase tracking-widest mb-3">Incident</p>
        <div className="flex flex-col gap-2">
          <Row label="Type" value={incident.incident_type} />
          {incident.round && (
            <Row
              label="Round"
              value={`Round ${incident.round}${incident.lap ? ` · Lap ${incident.lap}` : ''}`}
            />
          )}
          {incident.season && <Row label="Season" value={incident.season} />}
        </div>
        <p className="text-white/60 text-sm mt-3 leading-relaxed">{incident.description}</p>
        {Array.isArray(incident.evidence_urls) && incident.evidence_urls.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {incident.evidence_urls.map((url: string, i: number) => (
              <a key={i} href={url} target="_blank" rel="noreferrer"
                className="text-rise-red text-xs underline">
                Evidence {i + 1}
              </a>
            ))}
          </div>
        )}
      </section>

      {/* AI Recommendation */}
      <section className="rounded-2xl border border-rise-red/30 bg-rise-red/5 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-rise-red text-[10px] uppercase tracking-widest font-bold">
            AI Recommendation
          </p>
          {incident.ai_analysed_at && (
            <button onClick={() => setShowAI(v => !v)} className="text-white/30 text-[10px]">
              {showAI ? 'Hide' : 'Show'}
            </button>
          )}
        </div>

        {!incident.ai_analysed_at ? (
          <button
            onClick={runAI}
            disabled={analysing}
            className="w-full py-3 rounded-xl bg-rise-red text-white text-sm font-bold active:opacity-80 transition-opacity disabled:opacity-50"
          >
            {analysing ? 'Analysing...' : '✨ Get AI Recommendation'}
          </button>
        ) : showAI && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-bold text-sm">{incident.ai_verdict}</p>
                {incident.ai_penalty && (
                  <p className="text-white/50 text-xs">{incident.ai_penalty}</p>
                )}
                {incident.ai_points > 0 && (
                  <p className="text-rise-red text-xs font-bold">{incident.ai_points} pts</p>
                )}
              </div>
              {confidence !== null && (
                <div className="flex flex-col items-center">
                  <span className="text-2xl font-black text-white">{confidence}%</span>
                  <span className="text-white/30 text-[10px]">confidence</span>
                </div>
              )}
            </div>

            {incident.ai_reasoning && (
              <p className="text-white/50 text-xs leading-relaxed border-t border-white/10 pt-3">
                {incident.ai_reasoning}
              </p>
            )}

            {Array.isArray(incident.ai_articles) && incident.ai_articles.length > 0 && (
              <div className="flex flex-wrap gap-1 border-t border-white/10 pt-3">
                {incident.ai_articles.map((a: string, i: number) => (
                  <span key={i} className="bg-white/10 text-white/60 text-[10px] px-2 py-1 rounded-full">
                    {a}
                  </span>
                ))}
              </div>
            )}

            <button
              onClick={acceptAI}
              className="w-full py-2 rounded-xl border border-rise-red text-rise-red text-xs font-bold mt-1"
            >
              Accept AI Recommendation
            </button>

            <button
              onClick={runAI}
              disabled={analysing}
              className="text-white/30 text-[10px] text-center"
            >
              {analysing ? 'Re-analysing...' : 'Re-run analysis'}
            </button>
          </div>
        )}
      </section>

      {/* Steward decision */}
      {incident.status !== 'resolved' && (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4 mb-4">
          <p className="text-white/30 text-[10px] uppercase tracking-widest mb-4">Your Decision</p>

          <p className="text-white/40 text-xs mb-2">Verdict</p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {VERDICT_OPTIONS.map(v => (
              <button
                key={v}
                onClick={() => setVerdict(v)}
                className={`py-2 rounded-xl text-xs font-bold transition-colors ${
                  verdict === v
                    ? 'bg-rise-red text-white'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <p className="text-white/40 text-xs mb-2">Penalty</p>
          <div className="flex flex-col gap-2 mb-4">
            {PENALTY_OPTIONS.map(p => (
              <button
                key={p}
                onClick={() => setPenalty(penalty === p ? '' : p)}
                className={`py-2 rounded-xl text-xs font-bold transition-colors ${
                  penalty === p
                    ? 'bg-white/20 text-white'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          <p className="text-white/40 text-xs mb-2">
            Penalty Points: <span className="text-rise-red font-bold">{points}</span>
          </p>
          <input
            type="range" min={0} max={12} step={1}
            value={points}
            onChange={e => setPoints(Number(e.target.value))}
            className="w-full accent-rise-red mb-4"
          />

          {isOverride && (
            <div className="mb-4">
              <p className="text-yellow-400 text-xs mb-2">⚠️ Override reason (differs from AI)</p>
              <textarea
                value={overrideReason}
                onChange={e => setOverrideReason(e.target.value)}
                placeholder="Why are you overriding the AI recommendation?"
                className="w-full bg-white/5 border border-yellow-400/30 rounded-xl p-3 text-white text-xs resize-none h-20 placeholder:text-white/20"
              />
            </div>
          )}

          <p className="text-white/40 text-xs mb-2">Steward Notes (optional)</p>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Additional notes for the record..."
            className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-white text-xs resize-none h-20 placeholder:text-white/20 mb-4"
          />

          <button
            onClick={resolve}
            disabled={!verdict || submitting}
            className="w-full py-4 rounded-2xl bg-rise-red text-white font-black text-sm disabled:opacity-40 active:opacity-80 transition-opacity"
          >
            {submitting ? 'Submitting...' : 'Submit Decision'}
          </button>
        </section>
      )}

      {/* Resolved summary */}
      {incident.status === 'resolved' && (
        <section className="rounded-2xl border border-green-500/20 bg-green-500/5 p-4">
          <p className="text-green-400 text-[10px] uppercase tracking-widest mb-3 font-bold">Decision</p>
          <Row label="Verdict" value={incident.verdict} />
          {incident.penalty && <Row label="Penalty" value={incident.penalty} />}
          {incident.penalty_points > 0 && (
            <Row label="Points" value={`${incident.penalty_points} pts`} />
          )}
          {incident.steward_notes && (
            <p className="text-white/40 text-xs mt-3 leading-relaxed">{incident.steward_notes}</p>
          )}
        </section>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span className="text-white/40 text-xs">{label}</span>
      <span className="text-white text-xs font-semibold">{String(value)}</span>
    </div>
  );
}
