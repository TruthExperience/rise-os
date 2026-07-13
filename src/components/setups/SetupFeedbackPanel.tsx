// src/components/setups/SetupFeedbackPanel.tsx
'use client';

import { useState } from 'react';

interface SetupAdjustment {
  param_key:  string;
  delta:      number;
  confidence: 'low' | 'medium' | 'high';
  reasoning:  string;
}

interface FeedbackResponse {
  feedback_id?:                 string;
  resulting_recommendation_id:  string | null;
  adjustments:                  SetupAdjustment[];
  adjusted_setup?:               Record<string, number>;
  summary:                       string;
  disclaimer?:                   string;
  parse_error:                   boolean;
}

interface SetupFeedbackPanelProps {
  recommendationId: string;
  currentSetup:     Record<string, number>;
  // Discord snowflake from session.user.discordId (next-auth jwt strategy,
  // token.sub / p.id). NOT a pitboss.drivers.id — the API route resolves
  // that server-side via resolveDriverIdFromSession().
  discordId?:       string;
  onAdjusted?:      (newRecommendationId: string, adjustedSetup: Record<string, number>) => void;
}

export function SetupFeedbackPanel({
  recommendationId,
  currentSetup,
  discordId,
  onAdjusted,
}: SetupFeedbackPanelProps) {
  const [feedbackText, setFeedbackText] = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [result, setResult]             = useState<FeedbackResponse | null>(null);
  const [error, setError]               = useState<string | null>(null);

  async function handleSubmit() {
    if (!feedbackText.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/setups/recommendations/${recommendationId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback_text: feedbackText, discord_id: discordId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Failed to process feedback');
        return;
      }

      setResult(data);

      if (data.resulting_recommendation_id && data.adjusted_setup) {
        onAdjusted?.(data.resulting_recommendation_id, data.adjusted_setup);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-white font-bold text-base uppercase tracking-widest">Feedback</h2>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div>
          <label htmlFor="setup-feedback" className="block text-xs text-gray-500 uppercase tracking-widest mb-2">
            How does the car feel?
          </label>
          <textarea
            id="setup-feedback"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            placeholder="e.g. Loose on exit through the fast corners, understeers into hairpins"
            rows={3}
            disabled={submitting}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-[#E8284A] disabled:opacity-50"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting || !feedbackText.trim()}
          className="w-full rounded-xl bg-[#E8284A] py-3 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Analyzing feedback…' : 'Get adjusted setup'}
        </button>

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {result?.parse_error && (
          <div className="rounded-xl border border-yellow-900 bg-yellow-950/50 px-4 py-3 text-sm text-yellow-300">
            Couldn't interpret that feedback automatically. Flagged for manual review.
          </div>
        )}

        {result && !result.parse_error && (
          <SetupFeedbackResult result={result} currentSetup={currentSetup} />
        )}
      </div>
    </div>
  );
}

function SetupFeedbackResult({
  result,
  currentSetup,
}: {
  result:       FeedbackResponse;
  currentSetup: Record<string, number>;
}) {
  if (result.adjustments.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-black/20 px-4 py-3 text-sm text-gray-500">
        {result.summary || 'No adjustments could be derived from that feedback — try being more specific.'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {result.summary && (
        <p className="text-sm text-gray-400">{result.summary}</p>
      )}

      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 text-gray-500">
            <tr>
              <th className="text-left px-3 py-2 text-xs uppercase tracking-widest font-medium">Parameter</th>
              <th className="text-right px-3 py-2 text-xs uppercase tracking-widest font-medium">Before</th>
              <th className="text-right px-3 py-2 text-xs uppercase tracking-widest font-medium">After</th>
              <th className="text-left px-3 py-2 text-xs uppercase tracking-widest font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {result.adjustments.map((adj) => {
              const before = currentSetup[adj.param_key] ?? 0;
              const after  = before + adj.delta;
              return (
                <tr key={adj.param_key} className="border-t border-gray-800">
                  <td className="px-3 py-2.5 text-gray-300 font-mono text-xs">{adj.param_key}</td>
                  <td className="px-3 py-2.5 text-right text-gray-500 font-mono text-xs">{before}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">
                    <span className={after > before ? 'text-green-400' : after < before ? 'text-[#E8284A]' : 'text-gray-500'}>
                      {after}
                      <span className="text-gray-600 ml-1">
                        ({adj.delta > 0 ? '+' : ''}{adj.delta})
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <ConfidenceBadge confidence={adj.confidence} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result.disclaimer && (
        <p className="text-xs text-gray-600 italic">{result.disclaimer}</p>
      )}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: 'low' | 'medium' | 'high' }) {
  const styles = {
    high:   'bg-green-950 text-green-400 border-green-800',
    medium: 'bg-yellow-950 text-yellow-400 border-yellow-800',
    low:    'bg-gray-800 text-gray-500 border-gray-700',
  }[confidence];

  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${styles}`}>
      {confidence}
    </span>
  );
}
