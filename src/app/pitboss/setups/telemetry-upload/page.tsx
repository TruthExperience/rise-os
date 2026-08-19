"use client";

import { useRef, useState } from "react";

const CAR_CLASSES = [
  { value: "F1_2025", label: "F1 2025" },
  { value: "F1_2026", label: "F1 2026" },
  { value: "F2_2024", label: "F2 2024" },
  { value: "F2_2025", label: "F2 2025" },
];

type Status = "idle" | "submitting" | "success" | "error";

// Infers the car class from real signals in the payload, so the driver
// doesn't have to know/select it manually most of the time. Returns the
// current dropdown value unchanged if nothing matches — this pre-fills
// the dropdown rather than hiding it, since F1 season (2025 vs 2026)
// can't be determined with confidence from the payload alone (see notes
// below), so the driver can still correct a low-confidence guess.
//
// Confirmed signals (from comparing two real F1 25 captures — one a base
// F1 career race, one an F2 2024 career race):
//   - tyres.tyreCompound: F2 compounds are explicitly prefixed "f2"
//     (e.g. "f2SuperSoft"); F1 compounds are plain codes (c1-c5, i, w).
//     This reliably distinguishes F1 vs F2.
//   - team.name: F2 team names carry an explicit season year suffix
//     (e.g. "Prema Racing 2024"). Extracted via regex when present.
// `game` is NOT a usable signal — both samples came from the same actual
// game (F1 25) but reported different values ("f123" vs "f126"), so it
// doesn't reliably track game version, season, or content pack. Matches
// the upload route's existing warning that this field can't be trusted.
// F1 season (2025 vs 2026) has no confirmed discriminating field yet —
// both real samples are F1 25, so this is left as the current selection
// until an actual F1 2026 capture surfaces a real signal.
function inferCarClassCode(lap: any, current: string): string {
  const tyreCompound: string = lap?.tyres?.tyreCompound ?? "";
  const teamName: string = lap?.team?.name ?? "";

  if (tyreCompound.toLowerCase().startsWith("f2")) {
    const yearMatch = teamName.match(/\b(20\d{2})\b/);
    if (yearMatch?.[1] === "2024") return "F2_2024";
    if (yearMatch?.[1] === "2025") return "F2_2025";
    // F2 confirmed but no season year found in team name — default to
    // the more recent F2 class rather than silently picking one anyway.
    return "F2_2025";
  }

  // Not F2 — likely F1, but season isn't reliably determinable yet.
  return current;
}

export default function TelemetryUploadPage() {
  const [raw, setRaw] = useState("");
  const [carClassCode, setCarClassCode] = useState("F1_2025");
  const [leagueId, setLeagueId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [autoDetected, setAutoDetected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleUploadResponse(res: Response) {
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
  }

  // Paste path — sends the wrapped JSON shape.
  async function handlePasteSubmit() {
    setStatus("submitting");
    setMessage(null);
    setDetail(null);

    let parsedLap: any;
    try {
      parsedLap = JSON.parse(raw);
    } catch {
      setStatus("error");
      setMessage("That's not valid JSON.");
      setDetail("Check for a missing bracket, comma, or quote and try again.");
      return;
    }

    const inferred = inferCarClassCode(parsedLap, carClassCode);
    if (inferred !== carClassCode) {
      setCarClassCode(inferred);
      setAutoDetected(true);
    }

    try {
      const res = await fetch("/api/pitboss/setups/telemetry-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car_class_code: inferred,
          league_id: leagueId.trim() || null,
          telemetry: parsedLap,
        }),
      });
      await handleUploadResponse(res);
      if (status !== "error") setRaw("");
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the server.");
      setDetail("Check your connection and try again.");
    }
  }

  // File path — actual multipart/form-data upload, exercising the
  // endpoint's file-handling branch. Reads the file client-side first
  // just to infer the car class and pre-fill the dropdown; the raw file
  // itself is still what's uploaded, unchanged, alongside the (possibly
  // driver-corrected) car_class_code and league_id as sibling fields.
  async function handleFileSubmit(file: File) {
    setStatus("submitting");
    setMessage(null);
    setDetail(null);

    let inferred = carClassCode;
    try {
      const text = await file.text();
      const parsedLap = JSON.parse(text);
      inferred = inferCarClassCode(parsedLap, carClassCode);
      if (inferred !== carClassCode) {
        setCarClassCode(inferred);
        setAutoDetected(true);
      }
    } catch {
      // Not valid JSON, or couldn't be read/parsed client-side — let the
      // server do real validation and report the actual error; don't
      // block the upload attempt just because inference failed.
    }

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("car_class_code", inferred);
      if (leagueId.trim()) formData.append("league_id", leagueId.trim());

      const res = await fetch("/api/pitboss/setups/telemetry-upload", {
        method: "POST",
        body: formData,
      });
      await handleUploadResponse(res);
      setSelectedFileName(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the server.");
      setDetail("Check your connection and try again.");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    handleFileSubmit(file);
  }

  function handleCarClassChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setCarClassCode(e.target.value);
    setAutoDetected(false);
  }

  const isSubmitting = status === "submitting";
  const canSubmitPaste = raw.trim().length > 0 && !isSubmitting;

  return (
    <main className="min-h-screen bg-rise-black text-white px-4 py-8 flex flex-col gap-6 max-w-xl mx-auto">
      <header className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-widest text-white/40">
          Setups / Telemetry
        </span>
        <h1 className="text-2xl font-bold">Upload a lap</h1>
        <p className="text-sm text-white/60">
          Upload the raw telemetry JSON from your session, or paste it below. Track and car are
          resolved automatically — just confirm the car class first.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <label htmlFor="car-class" className="text-sm font-medium text-white/80">
          Car class
        </label>
        <select
          id="car-class"
          value={carClassCode}
          onChange={handleCarClassChange}
          disabled={isSubmitting}
          className="bg-gray-900 border border-white/10 rounded-lg px-3 py-3 text-base text-white focus:outline-none focus:ring-2 focus:ring-rise-red disabled:opacity-50"
        >
          {CAR_CLASSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {autoDetected && (
          <p className="text-xs text-emerald-400/80">
            Auto-detected from the uploaded lap — change it if this isn't right.
          </p>
        )}
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
        <label htmlFor="telemetry-file" className="text-sm font-medium text-white/80">
          Upload file
        </label>
        <input
          id="telemetry-file"
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          disabled={isSubmitting}
          className="text-sm text-white/70 file:mr-3 file:rounded-lg file:border-0 file:bg-rise-red file:text-white file:px-4 file:py-3 file:font-semibold file:text-sm disabled:opacity-50"
        />
        {selectedFileName && (
          <p className="text-xs text-white/40">{selectedFileName}</p>
        )}
      </section>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/10" />
        <span className="text-xs text-white/40">or paste instead</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

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
          rows={10}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="bg-gray-900 border border-white/10 rounded-lg px-3 py-3 text-sm font-mono text-white/90 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-rise-red disabled:opacity-50 resize-y"
        />
      </section>

      <button
        onClick={handlePasteSubmit}
        disabled={!canSubmitPaste}
        className="w-full py-4 rounded-lg font-semibold text-base bg-white/10 text-white disabled:bg-white/5 disabled:text-white/30 active:scale-[0.99] transition"
      >
        {isSubmitting ? "Uploading…" : "Submit pasted JSON"}
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
