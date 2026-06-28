'use client';

import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

const TYPE_LABELS: Record<string, string> = {
  collision:       '💥 Collision',
  unsafe_release:  '🚦 Unsafe Release',
  track_limits:    '🟡 Track Limits',
  blocking:        '🚧 Blocking',
  false_start:     '🏁 False Start',
  disconnect:      '📡 Disconnect',
  unsportsmanlike: '😤 Unsportsmanlike',
  other:           '📋 Other',
};

const STATUS_COLORS: Record<string, string> = {
  open:     'text-rise-red',
  reviewing: 'text-yellow-400',
  resolved: 'text-green-400',
};

export default function StewardPage() {
  const { data: session, status } = useSession();
  const router       = useRouter();
  const searchParams = useSearchParams();
  const league_id    = searchParams.get('league_id');

  const [incidents, setIncidents] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState<'open' | 'resolved'>('open');

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login');
  }, [status]);

  useEffect(() => {
    if (league_id) fetchIncidents();
  }, [league_id, filter]);

  async function fetchIncidents() {
    setLoading(true);
    try {
      const res = await fetch(`/api/pitboss/steward?league_id=${league_id}&status=${filter}`);
      if (res.ok) setIncidents((await res.json()).incidents ?? []);
    } finally {
      setLoading(false);
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button onClick={() => router.back()} className="text-white/40 text-sm mb-6 flex items-center gap-2">
        ← Back
      </button>

      <h1 className="text-2xl font-black text-white mb-1">Steward Panel</h1>
      <p className="text-white/30 text-xs uppercase tracking-widest mb-6">Incident Review</p>

      <div className="flex gap-2 mb-6">
        {(['open', 'resolved'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest transition-colors ${
              filter === f
                ? 'bg-rise-red text-white'
                : 'bg-white/5 text-white/40'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {incidents.length === 0 ? (
        <p className="text-white/30 text-sm text-center mt-16">
          No {filter} incidents.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {incidents.map(inc => (
            <button
              key={inc.id}
              onClick={() => router.push(`/pitboss/steward/${inc.id}?league_id=${league_id}`)}
              className="rounded-2xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-white text-sm font-bold">
                  {TYPE_LABELS[inc.incident_type] ?? inc.incident_type}
                </span>
                <span className={`text-[10px] font-bold uppercase ${STATUS_COLORS[inc.status] ?? 'text-white/40'}`}>
                  {inc.status}
                </span>
              </div>
              <p className="text-white/50 text-xs line-clamp-2 mb-3">{inc.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-white/30 text-[10px]">
                  {inc.round ? `Round ${inc.round}` : ''}
                  {inc.lap ? ` · Lap ${inc.lap}` : ''}
                </span>
                {inc.ai_analysed_at && (
                  <span className="text-rise-red text-[10px] font-bold">AI ✓</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
