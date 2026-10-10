"use client";

import { useCallback, useRef, useState } from "react";

// Bulk import for single-lap F1 telemetry exports. Each lap is posted, one at a
// time, to the existing ingest route, so every lap gets the same validation,
// track/car-class resolution, setup submission, archive row, coaching pass and
// (session_uid, lap_num) duplicate protection as a normal upload. Re-running the
// same files is safe: laps already imported come back as "already imported".
//
// The car class is worked out per lap with the page's inferCarClass (F2 laps are
// detected from the payload); anything it can't tell falls back to the page's
// car class dropdown, so a mixed F1 + F2 batch imports correctly.

const INGEST_URL = "/api/pitboss/setups/telemetry-ingest";
// Vercel functions reject request bodies over 4.5 MB, below the route's own 6 MB cap.
const MAX_BODY_CHARS = 4 * 1024 * 1024;
const GAP_MS = 250;
const RATE_LIMIT_WAIT_MS = 20_000; // route allows 20 uploads/min per driver
const MAX_RATE_LIMIT_RETRIES = 3;

type ItemStatus = "queued" | "uploading" | "created" | "existing" | "failed" | "skipped";

interface Item {
  id: string;
  label: string;
  lap: any | null;
  status: ItemStatus;
  message?: string;
  lapTime?: number;
  carClass?: string;
}

interface BulkTelemetryImportProps {
  /** Fallback car class (the page's dropdown) when a lap's class can't be detected. */
  carClassCode: string;
  leagueId: string;
  /** Per-lap car class detection, e.g. the page's inferCarClassCode. */
  inferCarClass?: (lap: any, fallback: string) => string;
  /** Disable while another upload on the page is running. */
  disabled?: boolean;
}

const STATUS_TEXT: Record<ItemStatus, string> = {
  queued: "queued",
  uploading: "importing",
  created: "imported",
  existing: "already imported",
  failed: "failed",
  skipped: "skipped",
};

// Full literal class names so Tailwind keeps them.
const STATUS_CLASS: Record<ItemStatus, string> = {
  queued: "text-white/40 border-white/10 bg-white/5",
  uploading: "text-sky-300 border-sky-500/30 bg-sky-500/10",
  created: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  existing: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  failed: "text-rise-red border-rise-red/30 bg-rise-red/10",
  skipped: "text-white/60 border-white/10 bg-white/5",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Accepts: one lap, an array of laps, { laps: [...] }, or the wrapped
// { telemetry: <lap> } form the ingest route also understands.
function toLap(x: any): any | null {
  if (x && typeof x.lapNum === "number" && Array.isArray(x.telemetry)) return x;
  if (x?.telemetry && typeof x.telemetry.lapNum === "number") return x.telemetry;
  return null;
}

function extractLaps(json: any): any[] {
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.laps) ? json.laps : [json];
  return list.map(toLap).filter((l): l is any => l !== null);
}

// Lap errors that retrying can never fix: marked skipped, not failed.
function isPermanentSkip(message: string): boolean {
  return message.startsWith("Lap is not valid") || message.startsWith("Telemetry frame array is empty");
}

export default function BulkTelemetryImport({
  carClassCode,
  leagueId,
  inferCarClass,
  disabled = false,
}: BulkTelemetryImportProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);

  const itemsRef = useRef<Item[]>([]);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const counterRef = useRef(0);

  // Latest props for the long-running loop, so changing the dropdown or league
  // mid-batch applies to the laps still waiting.
  const propsRef = useRef({ carClassCode, leagueId, inferCarClass });
  propsRef.current = { carClassCode, leagueId, inferCarClass };

  const commit = () => setItems([...itemsRef.current]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const added: Item[] = [];

    for (const file of files) {
      try {
        const json = JSON.parse(await file.text());
        const laps = extractLaps(json);
        if (laps.length === 0) {
          throw new Error("No lap found. Expected a single-lap export, an array of laps, or { laps: [...] }.");
        }
        for (const lap of laps) {
          added.push({
            id: `item-${counterRef.current++}`,
            label: laps.length > 1 ? `${file.name} · lap ${lap.lapNum}` : file.name,
            lap,
            status: "queued",
            lapTime: typeof lap.lapTime === "number" ? lap.lapTime : undefined,
          });
        }
      } catch (err) {
        added.push({
          id: `item-${counterRef.current++}`,
          label: file.name,
          lap: null,
          status: "skipped",
          message: err instanceof Error ? err.message : "Could not read this file",
        });
      }
    }

    itemsRef.current = [...itemsRef.current, ...added];
    commit();
  }

  async function postLap(lap: any, carClass: string): Promise<{ status: number; data: any }> {
    const body = JSON.stringify({
      telemetry: lap,
      car_class_code: carClass,
      league_id: propsRef.current.leagueId.trim() || null,
    });
    if (body.length > MAX_BODY_CHARS) {
      return { status: 413, data: { error: "Lap is too large to upload (over 4 MB)" } };
    }
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const run = useCallback(async (retryFailed: boolean) => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    setRunning(true);

    if (retryFailed) {
      for (const it of itemsRef.current) {
        if (it.status === "failed" && it.lap) {
          it.status = "queued";
          it.message = undefined;
        }
      }
      commit();
    }

    const todo = itemsRef.current.filter((it) => it.status === "queued" && it.lap);

    for (const item of todo) {
      if (cancelRef.current) break;

      const { carClassCode: fallback, inferCarClass: infer } = propsRef.current;
      const carClass = infer ? infer(item.lap, fallback) : fallback;

      item.status = "uploading";
      item.message = undefined;
      item.carClass = carClass;
      commit();

      let attempt = 0;
      for (;;) {
        try {
          const { status, data } = await postLap(item.lap, carClass);

          if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES && !cancelRef.current) {
            attempt++;
            item.message = `Rate limited, waiting ${RATE_LIMIT_WAIT_MS / 1000}s…`;
            commit();
            await sleep(RATE_LIMIT_WAIT_MS);
            continue;
          }

          if (status === 201) {
            item.status = "created";
            item.message = undefined;
          } else if (status === 200) {
            item.status = "existing";
            item.message = "Already in the database; its archive was refreshed.";
          } else {
            const msg: string = data?.error ?? `Request failed (${status})`;
            item.status = isPermanentSkip(msg) || status === 413 ? "skipped" : "failed";
            item.message = msg;
          }
        } catch (err) {
          item.status = "failed";
          item.message = err instanceof Error ? err.message : "Network error";
        }
        break;
      }

      // Free the lap payload (hundreds of KB each) once it's settled.
      if (item.status === "created" || item.status === "existing" || item.status === "skipped") {
        item.lap = null;
      }
      commit();
      await sleep(GAP_MS);
    }

    runningRef.current = false;
    setRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearFinished() {
    itemsRef.current = itemsRef.current.filter((it) => it.status === "queued" || it.status === "uploading");
    commit();
  }

  const count = (s: ItemStatus) => items.filter((it) => it.status === s).length;
  const queued = count("queued");
  const failed = items.filter((it) => it.status === "failed" && it.lap).length;
  const done = items.length - queued - count("uploading");
  const locked = running || disabled;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-white/10 bg-gray-900/60 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-white/80">Import many laps</h2>
        <p className="text-xs text-white/40">
          Pick several lap files at once. Laps already imported are refreshed, not duplicated.
          Car class is detected per lap; otherwise the selection above is used.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <label
          className={`rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold text-white ${
            locked ? "pointer-events-none opacity-50" : "cursor-pointer active:scale-[0.99]"
          }`}
        >
          Choose files
          <input
            type="file"
            accept=".json,application/json"
            multiple
            disabled={locked}
            onChange={onPick}
            className="hidden"
          />
        </label>

        <button
          type="button"
          onClick={() => run(false)}
          disabled={locked || queued === 0}
          className="rounded-lg bg-rise-red px-4 py-3 text-sm font-semibold text-white disabled:bg-white/5 disabled:text-white/30 active:scale-[0.99]"
        >
          {running ? "Importing…" : `Import ${queued} lap${queued === 1 ? "" : "s"}`}
        </button>

        {running && (
          <button
            type="button"
            onClick={() => { cancelRef.current = true; }}
            className="rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold text-white active:scale-[0.99]"
          >
            Stop after this lap
          </button>
        )}

        {!running && failed > 0 && (
          <button
            type="button"
            onClick={() => run(true)}
            disabled={disabled}
            className="rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 active:scale-[0.99]"
          >
            Retry {failed} failed
          </button>
        )}

        {!running && done > 0 && (
          <button
            type="button"
            onClick={clearFinished}
            className="rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold text-white active:scale-[0.99]"
          >
            Clear finished
          </button>
        )}
      </div>

      {items.length > 0 && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/60">
          <span>{done}/{items.length} done</span>
          <span className="text-emerald-300">{count("created")} imported</span>
          <span className="text-amber-300">{count("existing")} already there</span>
          <span className="text-rise-red">{count("failed")} failed</span>
          <span>{count("skipped")} skipped</span>
        </p>
      )}

      {items.length > 0 && (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {items.map((it) => (
            <li key={it.id} className="rounded-lg border border-white/10 bg-gray-900 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-white/90">
                  {it.label}
                  {it.lapTime != null && (
                    <span className="text-white/40"> · {it.lapTime.toFixed(3)}s</span>
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_CLASS[it.status]}`}
                >
                  {STATUS_TEXT[it.status]}
                </span>
              </div>
              {it.carClass && it.status !== "queued" && (
                <p className="mt-1 text-xs text-white/40">{it.carClass}</p>
              )}
              {it.message && (
                <p className={`mt-1 text-xs ${it.status === "failed" ? "text-rise-red" : "text-white/60"}`}>
                  {it.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
