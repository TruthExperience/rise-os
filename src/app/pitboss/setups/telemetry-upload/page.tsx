"use client";

import { useState } from "react";

const CAR_CLASSES = [
  { value: "F1_2025", label: "F1 2025" },
  { value: "F1_2026", label: "F1 2026" },
  { value: "F2_2024", label: "F2 2024" },
  { value: "F2_2025", label: "F2 2025" },
];

type Status = "idle" | "submitting" | "success" | "error";

export default function TelemetryUploadPage() {
  const [raw, setRaw] = useState("");
  const [carClassCode, setCarClassCode] = useState("F1_2025");
  const [leagueId, setLeagueId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  async function handleSubmit() {
    setStatus("submitting");
    setMessage(null);
    setDetail(null);

    let parsedLap: unknown;
    try {
      parsedLap = JSON.parse(raw);
    } catch {
      setStatus("error");
      setMessage("That's not valid JSON.");
      setDetail("Check for a missing bracket, comma, or quote and try again.");
      return;
    }

    try {
      const res = await fetch("/api/pitboss/setups/telemetry-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car_class_code: carClassCode,
          league_id: leagueId.trim() || null,
          telemetry: parsedLap,
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setStatus("error");
        setMessage(body?.error ?? `Upload failed (${res.status}).`);
        setDetail(null);
        return;
      }

      setStatus("success");
      setMessage("Lap uploaded and archived.");
      setDetail(
        [
          body?.submission?.id ? `Submission ${body.submission.id}` : null,
          body?.resolved?.conditions && body?.resolved?.session_type
            ? `${body.resolved.session_type} · ${body.resolved.conditions}`
            : null,
          body?.telemetry_upload_id ? "Raw lap archived." : "Raw lap archive skipped (submission still saved).",
        ]
          .filter(Boolean)
          .join(" — ")
      );
      setRaw("");
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the server.");
      setDetail("Check your connection and try again.");
    }
  }

  const isSubmitting = status === "submitting";
  const canSubmit = raw.trim().length > 0 && !isSubmitting;

  return (
    <main className="min-h-screen bg-rise-black text-white px-4 py-8 flex flex-col gap-6 max-w-xl mx-auto">
      <header className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-widest text-white/40">
          Setups / Telemetry
        </span>
        <h1 className="text-2xl font-bold">Upload a lap</h1>
        <p className="text-sm text-white/60">
          Paste the raw telemetry JSON from your session. Track and car are resolved automatically —
          just confirm the car class below.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <label htmlFor="car-class" className="text-sm font-medium text-white/80">
          Car class
        </label>
        <select
          id="car-class"
          value={carClassCode}
          onChange={(e) => setCarClassCode(e.target.value)}
          disabled={isSubmitting}
          className="bg-gray-900 border border-white/10 rounded-lg px-3 py-3 text-base text-white focus:outline-none focus:ring-2 focus:ring-rise-red disabled:opacity-50"
        >
          {CAR_CLASSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="league-id" className="text-sm font-medium text-white/80">
          League ID <span className="text-white/40 font-normal">(optional)</span>
        </label>
        <input
          id="league-id"
          type="text"
          value={leagueId}
          onChange={(e) => setLeagueId(e.target.value)}
          disabled={isSubmitting}
          placeholder="Leave blank for none"
          className="bg-gray-900 border border-white/10 rounded-lg px-3 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-rise-red disabled:opacity-50"
        />
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="telemetry-json" className="text-sm font-medium text-white/80">
          Telemetry JSON
        </label>
        <textarea
          id="telemetry-json"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          disabled={isSubmitting}
          placeholder="Paste the full lap JSON here"
          rows={12}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="bg-gray-900 border border-white/10 rounded-lg px-3 py-3 text-sm font-mono text-white/90 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-rise-red disabled:opacity-50 resize-y"
        />
      </section>

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full py-4 rounded-lg font-semibold text-base bg-rise-red text-white disabled:bg-white/10 disabled:text-white/40 active:scale-[0.99] transition"
      >
        {isSubmitting ? "Uploading…" : "Upload lap"}
      </button>

      {status !== "idle" && message && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            status === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : status === "error"
              ? "border-rise-red/30 bg-rise-red/10 text-rise-red"
              : "border-white/10 bg-white/5 text-white/70"
          }`}
        >
          <p className="font-medium">{message}</p>
          {detail && <p className="mt-1 text-white/60">{detail}</p>}
        </div>
      )}
    </main>
  );
}
