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
  driverId?:        string;
  onAdjusted?:      (newRecommendationId: string, adjustedSetup: Record<string, number>) => void;
}

export function SetupFeedbackPanel({
  recommendationId,
  currentSetup,
  driverId,
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
        body: JSON.stringify({ feedback_text: feedbackText, driver_id: driverId }),
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 space-y-4">
      <div>
        <label htmlFor="setup-feedback" className="block text-sm font-medium text-neutral-300 mb-1">
          How does the car feel?
        </label>
        <textarea
          id="setup-feedback"
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          placeholder="e.g. Loose on exit through the fast corners, understeers into hairpins"
          rows={3}
          disabled={submitting}
          className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting || !feedbackText.trim()}
        className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? 'Analyzing feedback…' : 'Get adjusted setup'}
      </button>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {result?.parse_error && (
        <div className="rounded-md border border-yellow-900 bg-yellow-950/50 px-3 py-2 text-sm text-yellow-300">
          Couldn't interpret that feedback automatically. Flagged for manual review.
        </div>
      )}

      {result && !result.parse_error && (
        <SetupFeedbackResult result={result} currentSetup={currentSetup} />
      )}
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
      <div className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-400">
        {result.summary || 'No adjustments could be derived from that feedback — try being more specific.'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {result.summary && (
        <p className="text-sm text-neutral-300">{result.summary}</p>
      )}

      <div className="rounded-md border border-neutral-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-800 text-neutral-400">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Parameter</th>
              <th className="text-right px-3 py-2 font-medium">Before</th>
              <th className="text-right px-3 py-2 font-medium">After</th>
              <th className="text-left px-3 py-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {result.adjustments.map((adj) => {
              const before = currentSetup[adj.param_key] ?? 0;
              const after  = before + adj.delta;
              return (
                <tr key={adj.param_key} className="border-t border-neutral-800">
                  <td className="px-3 py-2 text-neutral-200 font-mono text-xs">{adj.param_key}</td>
                  <td className="px-3 py-2 text-right text-neutral-400 font-mono text-xs">{before}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    <span className={after > before ? 'text-green-400' : after < before ? 'text-red-400' : 'text-neutral-400'}>
                      {after}
                      <span className="text-neutral-500 ml-1">
                        ({adj.delta > 0 ? '+' : ''}{adj.delta})
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <ConfidenceBadge confidence={adj.confidence} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result.disclaimer && (
        <p className="text-xs text-neutral-500 italic">{result.disclaimer}</p>
      )}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: 'low' | 'medium' | 'high' }) {
  const styles = {
    high:   'bg-green-950 text-green-400 border-green-800',
    medium: 'bg-yellow-950 text-yellow-400 border-yellow-800',
    low:    'bg-neutral-800 text-neutral-400 border-neutral-700',
  }[confidence];

  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${styles}`}>
      {confidence}
    </span>
  );
}
