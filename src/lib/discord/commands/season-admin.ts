import { registerCommand, type CommandContext } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import { getOrCreateDriver } from "./checkin";
import { postRoundResultsToDiscord, syncStandingsToDiscord } from "@/lib/discord/standings-post";

// Owner-only season administration from Discord:
//
//   /calendar add | import | list | remove     -> rise_os.calendar_rounds
//   /set-result                                -> pitboss.results (one driver)
//   /import-results                            -> pitboss.results (CSV upload)
//   /set-standings                             -> pitboss.standings_adjustments
//
// Standings are computed live from pitboss.results (see standings.ts), so
// entering results IS how standings move. /set-standings exists for
// setting a driver's total directly (e.g. carrying over points from before
// the bot) — it records an audited adjustment row for the difference
// instead of editing results.
//
// Points for results come from pitboss.league_points_table (position ->
// points, fastest_lap_bonus, pole_bonus, sprint_points). A league with no points table
// gets 0 points unless `points` is given explicitly.
//
// calendar_rounds has no unique key, and break rows share round_number with
// race rows, so every lookup here filters on type as well.
//
// Owners only: is_owner / is_co_owner / is_commissioner.

const OWNER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;
const MAX_IMPORT_ROWS = 60;
const MAX_MESSAGE = 1900;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function ownerGuard(ctx: CommandContext) {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { error: "This command must be used in a league channel." } as const;
  }
  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { error: "Only league owners can do that." } as const;
  }
  return { leagueId } as const;
}

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE - 1) + "…" : text;
}

/**
 * Refreshes the league's Discord posts after results or standings change:
 * recomputes the standings table, edits the round's race/quali result posts,
 * then edits the driver and team standings posts. These need channels set up
 * in pitboss.standings_discord_sync and never throw, so a Discord problem
 * can't undo a save. Call from a deferred (background) step, since it makes
 * several Discord API calls. `force` re-posts the standings even when the
 * results themselves haven't changed (e.g. a manual standings adjustment).
 */
async function refreshDiscordPosts(
  leagueId: string,
  rounds: Array<{ season: string | number; round: number }>,
  opts: { force?: boolean } = {}
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const rc = await supabase.schema("pitboss").rpc("recompute_driver_standings");
    if (rc.error) console.error("[season-admin] standings recompute failed:", rc.error.message);
    for (const r of rounds) {
      await postRoundResultsToDiscord(leagueId, r.season, r.round);
    }
    await syncStandingsToDiscord(leagueId, { force: opts.force });
  } catch (err) {
    console.error("[season-admin] Discord refresh failed:", err);
  }
}

function toInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type RoundType = "race" | "break" | "testing";
const ROUND_TYPES: RoundType[] = ["race", "break", "testing"];

// --- CSV --------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    field = "";
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
    }
  }
  endRow();
  return rows;
}

async function readCsvAttachment(ctx: CommandContext, optionName: string) {
  const attachmentId = ctx.options[optionName] as string | undefined;
  const attachment = attachmentId ? ctx.resolvedAttachments[attachmentId] : undefined;
  if (!attachment) return { error: "Attach a CSV file." } as const;

  const looksLikeCsv =
    attachment.filename?.toLowerCase().endsWith(".csv") ||
    attachment.contentType?.includes("csv") ||
    attachment.contentType?.startsWith("text/");
  if (!looksLikeCsv) return { error: "That file doesn't look like a CSV." } as const;

  const res = await fetch(attachment.url);
  if (!res.ok) return { error: `Couldn't download the attachment (${res.status}).` } as const;

  const text = (await res.text()).replace(/^\uFEFF/, "");
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { error: "The CSV needs a header row and at least one data row." } as const;
  }
  if (rows.length - 1 > MAX_IMPORT_ROWS) {
    return { error: `Too many rows (max ${MAX_IMPORT_ROWS} per import).` } as const;
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = (r[i] ?? "").trim();
    });
    return rec;
  });
  return { header, records } as const;
}

function csvInt(value: string | undefined, field: string): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${field} "${value}" isn't a whole number`);
  return n;
}

function csvNumber(value: string | undefined, field: string): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} "${value}" isn't a number`);
  return n;
}

function csvBool(value: string | undefined): boolean {
  return !!value && ["true", "yes", "y", "1", "x"].includes(value.trim().toLowerCase());
}

// --- Divisions --------------------------------------------------------------

async function resolveDivisionId(leagueId: string, code: string | undefined) {
  if (!code) return { divisionId: null } as const;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select("id")
    .eq("league_id", leagueId)
    .ilike("division_code", code)
    .maybeSingle();
  if (error) return { error: error.message } as const;
  if (!data) return { error: `No division "${code}" set up for this league.` } as const;
  return { divisionId: data.id as string } as const;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

interface RoundInput {
  seasonNumber: number;
  roundNumber: number;
  type: RoundType;
  name: string;
  circuit: string | null;
  country: string | null;
  flag: string | null;
  raceDate: string | null;
  isSprint: boolean;
  divisionId: string | null;
}

async function findRoundRow(
  leagueId: string,
  seasonNumber: number,
  roundNumber: number,
  type: RoundType,
  divisionId: string | null
) {
  const supabase = createAdminClient();
  let query = supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("id, name")
    .eq("league_id", leagueId)
    .eq("season_number", seasonNumber)
    .eq("round_number", roundNumber)
    .eq("type", type);
  query = divisionId ? query.eq("division_id", divisionId) : query.is("division_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) return { error: error.message } as const;
  return { row: data } as const;
}

/**
 * Adds the round, or updates it if one already exists for the same
 * league + season + round number + type + division. On update, fields that
 * weren't provided (null) are left as they are rather than cleared.
 */
async function saveRound(leagueId: string, r: RoundInput) {
  const supabase = createAdminClient();
  const found = await findRoundRow(leagueId, r.seasonNumber, r.roundNumber, r.type, r.divisionId);
  if ("error" in found) return { error: found.error } as const;

  if (found.row) {
    const patch: Record<string, unknown> = { name: r.name, is_sprint: r.isSprint };
    if (r.circuit !== null) patch.circuit = r.circuit;
    if (r.country !== null) patch.country = r.country;
    if (r.flag !== null) patch.flag_emoji = r.flag;
    if (r.raceDate !== null) patch.race_date = r.raceDate;

    const { error } = await supabase
      .schema("rise_os")
      .from("calendar_rounds")
      .update(patch)
      .eq("id", found.row.id);
    if (error) return { error: error.message } as const;
    return { action: "updated" } as const;
  }

  const { error } = await supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .insert({
      league_id: leagueId,
      season_number: r.seasonNumber,
      round_number: r.roundNumber,
      type: r.type,
      name: r.name,
      circuit: r.circuit,
      country: r.country,
      flag_emoji: r.flag,
      race_date: r.raceDate,
      is_sprint: r.isSprint,
      division_id: r.divisionId,
    });
  if (error) return { error: error.message } as const;
  return { action: "added" } as const;
}

registerCommand("calendar_add", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;

  const seasonNumber = toInt(ctx.options.season);
  const roundNumber = toInt(ctx.options.round);
  const name = (ctx.options.name as string | undefined)?.trim();
  if (seasonNumber === null || roundNumber === null || !name) {
    return { content: "season, round and name are required.", ephemeral: true };
  }

  const type = ((ctx.options.type as string | undefined) ?? "race") as RoundType;
  if (!ROUND_TYPES.includes(type)) {
    return { content: "type must be race, break or testing.", ephemeral: true };
  }

  const date = (ctx.options.date as string | undefined)?.trim() || null;
  if (date && !validDate(date)) {
    return { content: "date must look like 2026-09-06.", ephemeral: true };
  }

  const division = await resolveDivisionId(leagueId, ctx.options.division as string | undefined);
  if ("error" in division) {
    return { content: division.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }

  const saved = await saveRound(leagueId, {
    seasonNumber,
    roundNumber,
    type,
    name,
    circuit: (ctx.options.circuit as string | undefined)?.trim() || null,
    country: (ctx.options.country as string | undefined)?.trim() || null,
    flag: (ctx.options.flag as string | undefined)?.trim() || null,
    raceDate: date,
    isSprint: Boolean(ctx.options.sprint),
    divisionId: division.divisionId,
  });
  if ("error" in saved) {
    console.error("[calendar_add] save failed:", saved.error);
    return { content: `Something went wrong saving the round: ${saved.error}`, ephemeral: true };
  }

  return {
    content: `${saved.action === "added" ? "Added" : "Updated"} season ${seasonNumber} round ${roundNumber}: **${name}**${date ? ` (${date})` : ""}.`,
    ephemeral: true,
  };
});

/**
 * CSV columns (header row required, any order):
 *   round (required), name (required), circuit, country, flag, date
 *   (YYYY-MM-DD), sprint (true/false), type (race/break/testing, default race)
 * Existing rounds with the same season + round + type + division are
 * updated, not duplicated. Nothing is ever deleted by an import.
 */
registerCommand("calendar_import", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;

  const seasonNumber = toInt(ctx.options.season);
  if (seasonNumber === null) {
    return { content: "season is required (a season number).", ephemeral: true };
  }

  const division = await resolveDivisionId(leagueId, ctx.options.division as string | undefined);
  if ("error" in division) {
    return { content: division.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const csv = await readCsvAttachment(ctx, "file");
      if ("error" in csv) return { content: csv.error ?? "Couldn't read the CSV." };

      if (!csv.header.includes("round") || !csv.header.includes("name")) {
        return { content: "The CSV header needs at least `round` and `name` columns." };
      }

      let added = 0;
      let updated = 0;
      const errors: string[] = [];

      for (let i = 0; i < csv.records.length; i++) {
        const rec = csv.records[i];
        const line = i + 2; // header is line 1
        try {
          const roundNumber = csvInt(rec.round, "round");
          if (roundNumber === null) throw new Error("round is blank");
          if (!rec.name) throw new Error("name is blank");

          const type = (rec.type ? rec.type.toLowerCase() : "race") as RoundType;
          if (!ROUND_TYPES.includes(type)) throw new Error(`type "${rec.type}" must be race, break or testing`);
          if (rec.date && !validDate(rec.date)) throw new Error(`date "${rec.date}" must look like 2026-09-06`);

          const saved = await saveRound(leagueId, {
            seasonNumber,
            roundNumber,
            type,
            name: rec.name,
            circuit: rec.circuit || null,
            country: rec.country || null,
            flag: rec.flag || null,
            raceDate: rec.date || null,
            isSprint: csvBool(rec.sprint),
            divisionId: division.divisionId,
          });
          if ("error" in saved) throw new Error(saved.error);
          if (saved.action === "added") added++;
          else updated++;
        } catch (err) {
          errors.push(`Line ${line}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const lines = [`Season ${seasonNumber} calendar: ${added} added, ${updated} updated, ${errors.length} skipped.`];
      if (errors.length > 0) lines.push("", ...errors.slice(0, 10));
      if (errors.length > 10) lines.push(`…and ${errors.length - 10} more.`);
      return { content: clip(lines.join("\n")) };
    },
  };
});

registerCommand("calendar_list", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;
  const supabase = createAdminClient();

  let seasonNumber = toInt(ctx.options.season);
  if (seasonNumber === null) {
    const { data: latest, error } = await supabase
      .schema("rise_os")
      .from("calendar_rounds")
      .select("season_number")
      .eq("league_id", leagueId)
      .order("season_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { content: `Something went wrong finding the season: ${error.message}`, ephemeral: true };
    }
    if (!latest) return { content: "No calendar set up for this league yet.", ephemeral: true };
    seasonNumber = latest.season_number as number;
  }

  const division = await resolveDivisionId(leagueId, ctx.options.division as string | undefined);
  if ("error" in division) {
    return { content: division.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }

  let query = supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("round_number, type, name, circuit, country, flag_emoji, race_date, is_sprint, status, division_id")
    .eq("league_id", leagueId)
    .eq("season_number", seasonNumber);
  if (division.divisionId) query = query.eq("division_id", division.divisionId);

  const { data: rounds, error } = await query
    .order("round_number", { ascending: true })
    .order("race_date", { ascending: true });
  if (error) {
    return { content: `Something went wrong pulling the calendar: ${error.message}`, ephemeral: true };
  }
  if (!rounds || rounds.length === 0) {
    return { content: `No rounds set up for season ${seasonNumber}.`, ephemeral: true };
  }

  const { data: divisions } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select("id, division_code")
    .eq("league_id", leagueId);
  const codeById = new Map((divisions ?? []).map((d) => [d.id as string, d.division_code as string]));

  const lines = rounds.map((r) => {
    const code = r.division_id ? codeById.get(r.division_id as string) : null;
    return (
      `${r.flag_emoji ?? ""} R${r.round_number ?? "-"} ${r.name}` +
      `${r.type !== "race" ? ` (${r.type})` : ""}` +
      ` — ${r.race_date ?? "TBD"}` +
      `${r.is_sprint ? " · sprint" : ""}` +
      `${code ? ` [${code}]` : ""}` +
      `${r.status && r.status !== "scheduled" ? ` · ${r.status}` : ""}`
    ).trim();
  });

  return { content: clip([`**Season ${seasonNumber} calendar**`, ...lines].join("\n")), ephemeral: true };
});

registerCommand("calendar_remove", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;

  const seasonNumber = toInt(ctx.options.season);
  const roundNumber = toInt(ctx.options.round);
  if (seasonNumber === null || roundNumber === null) {
    return { content: "season and round are required.", ephemeral: true };
  }

  const type = ((ctx.options.type as string | undefined) ?? "race") as RoundType;
  if (!ROUND_TYPES.includes(type)) {
    return { content: "type must be race, break or testing.", ephemeral: true };
  }

  const division = await resolveDivisionId(leagueId, ctx.options.division as string | undefined);
  if ("error" in division) {
    return { content: division.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }

  const found = await findRoundRow(leagueId, seasonNumber, roundNumber, type, division.divisionId);
  if ("error" in found) {
    return { content: `Something went wrong finding that round: ${found.error}`, ephemeral: true };
  }
  if (!found.row) {
    return { content: `No ${type} found for season ${seasonNumber} round ${roundNumber}.`, ephemeral: true };
  }

  const supabase = createAdminClient();
  const { count, error: countError } = await supabase
    .schema("pitboss")
    .from("results")
    .select("id", { count: "exact", head: true })
    .eq("round_id", found.row.id);
  if (countError) {
    return { content: `Something went wrong checking for results: ${countError.message}`, ephemeral: true };
  }
  if ((count ?? 0) > 0) {
    return {
      content: `**${found.row.name}** already has ${count} result(s) recorded, so it can't be removed.`,
      ephemeral: true,
    };
  }

  const { error: deleteError } = await supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .delete()
    .eq("id", found.row.id);
  if (deleteError) {
    // Most likely a check-in post or other row still references this round.
    return {
      content: `Couldn't remove **${found.row.name}**: ${deleteError.message}`,
      ephemeral: true,
    };
  }

  return { content: `Removed season ${seasonNumber} round ${roundNumber}: **${found.row.name}**.`, ephemeral: true };
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Resolves a single RACE round (type = 'race') by season + round number or
 * name. Breaks share round numbers with races on this calendar, and D1/D2
 * rows share them too, so this filters on type and refuses to guess when
 * more than one division matches.
 */
async function resolveRaceRound(
  leagueId: string,
  seasonNumber: number,
  roundInput: string,
  divisionId: string | null
) {
  const supabase = createAdminClient();
  let query = supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("id, season_number, round_number, name, circuit, division_id")
    .eq("league_id", leagueId)
    .eq("season_number", seasonNumber)
    .eq("type", "race");

  if (divisionId) query = query.eq("division_id", divisionId);

  const asNumber = Number(roundInput);
  query = Number.isFinite(asNumber)
    ? query.eq("round_number", asNumber)
    : query.ilike("name", `%${roundInput}%`);

  const { data, error } = await query.limit(2);
  if (error) return { error: error.message } as const;
  if (!data || data.length === 0) {
    return { error: `No race matching "${roundInput}" in season ${seasonNumber}.` } as const;
  }
  if (data.length > 1) {
    return {
      error: `More than one race matches "${roundInput}" in season ${seasonNumber} — add \`division\` to pick one.`,
    } as const;
  }
  const round = data[0];
  if (round.round_number == null) {
    return { error: `${round.name} has no round number on the calendar.` } as const;
  }
  return { round } as const;
}

interface PointsRow {
  points: number;
  sprintPoints: number;
}
interface PointsTable {
  byPosition: Map<number, PointsRow>;
  fastestLapBonus: number;
  poleBonus: number;
}

async function loadPointsTable(leagueId: string): Promise<PointsTable> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .schema("pitboss")
    .from("league_points_table")
    .select("position, points, fastest_lap_bonus, pole_bonus, sprint_points")
    .eq("league_id", leagueId);

  const byPosition = new Map<number, PointsRow>();
  let fastestLapBonus = 0;
  let poleBonus = 0;
  for (const row of data ?? []) {
    byPosition.set(row.position as number, {
      points: Number(row.points ?? 0),
      sprintPoints: Number(row.sprint_points ?? 0),
    });
    fastestLapBonus = Math.max(fastestLapBonus, Number(row.fastest_lap_bonus ?? 0));
    poleBonus = Math.max(poleBonus, Number(row.pole_bonus ?? 0));
  }
  return { byPosition, fastestLapBonus, poleBonus };
}

interface ResultInput {
  leagueId: string;
  driverId: string;
  round: { id: string; season_number: number; round_number: number | null; circuit: string | null };
  quali: number | null;
  finish: number | null;
  dnf: boolean;
  dnfReason: string | null;
  fastestLap: boolean;
  pointsOverride: number | null;
  sprintFinish: number | null;
}

/**
 * Upserts one driver's result row for a round (unique on league + driver +
 * season + round, so re-entering overwrites). Points come from the league's
 * points table unless an override is given. Returns the points awarded.
 */
async function saveResult(input: ResultInput, table: PointsTable) {
  const supabase = createAdminClient();
  const { round } = input;
  if (round.round_number == null) return { error: "Round has no round number." } as const;

  let points = 0;
  if (input.pointsOverride !== null) {
    points = input.pointsOverride;
  } else if (!input.dnf && input.finish !== null) {
    points = table.byPosition.get(input.finish)?.points ?? 0;
    if (input.fastestLap) points += table.fastestLapBonus;
    if (input.quali === 1) points += table.poleBonus;
  }

  const sprintPoints =
    input.sprintFinish !== null ? table.byPosition.get(input.sprintFinish)?.sprintPoints ?? 0 : 0;

  const { data: roster } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("franchise_id")
    .eq("league_id", input.leagueId)
    .eq("driver_id", input.driverId)
    .eq("season", String(round.season_number))
    .is("released_at", null)
    .limit(1)
    .maybeSingle();

  const { error } = await supabase
    .schema("pitboss")
    .from("results")
    .upsert(
      {
        league_id: input.leagueId,
        driver_id: input.driverId,
        season: String(round.season_number),
        round: round.round_number,
        round_id: round.id,
        track: round.circuit,
        qualifying_position: input.quali,
        finish_position: input.dnf ? null : input.finish,
        dnf: input.dnf,
        dnf_reason: input.dnf ? input.dnfReason : null,
        fastest_lap: input.fastestLap,
        points_earned: points,
        franchise_id: roster?.franchise_id ?? null,
        sprint_finish_position: input.sprintFinish,
        sprint_points_earned: sprintPoints,
      },
      { onConflict: "league_id,driver_id,season,round" }
    );
  if (error) return { error: error.message } as const;

  return { points, sprintPoints } as const;
}

registerCommand("set-result", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;

  const driverDiscordId = ctx.options.driver as string | undefined;
  const seasonNumber = toInt(ctx.options.season);
  const roundInput = (ctx.options.round as string | number | undefined)?.toString().trim();
  if (!driverDiscordId || seasonNumber === null || !roundInput) {
    return { content: "driver, season and round are required.", ephemeral: true };
  }

  const dnf = Boolean(ctx.options.dnf);
  const finish = toInt(ctx.options.finish);
  const quali = toInt(ctx.options.quali);
  const sprintFinish = toInt(ctx.options.sprint_finish);
  if (!dnf && (finish === null || finish < 1)) {
    return { content: "finish (a position of 1 or higher) is required unless the driver DNF'd.", ephemeral: true };
  }
  if ((quali !== null && quali < 1) || (sprintFinish !== null && sprintFinish < 1)) {
    return { content: "Positions must be 1 or higher.", ephemeral: true };
  }

  const pointsRaw = ctx.options.points;
  const pointsOverride = pointsRaw === undefined || pointsRaw === null ? null : Number(pointsRaw);
  if (pointsOverride !== null && !Number.isFinite(pointsOverride)) {
    return { content: "points must be a number.", ephemeral: true };
  }

  const division = await resolveDivisionId(leagueId, ctx.options.division as string | undefined);
  if ("error" in division) {
    return { content: division.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }

  const roundResult = await resolveRaceRound(leagueId, seasonNumber, roundInput, division.divisionId);
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const driverResult = await getOrCreateDriver(driverDiscordId, ctx.resolvedUsers[driverDiscordId]?.username);
  if ("error" in driverResult) {
    return { content: `Couldn't resolve that driver: ${driverResult.error}`, ephemeral: true };
  }

  const table = await loadPointsTable(leagueId);
  const saved = await saveResult(
    {
      leagueId,
      driverId: driverResult.driver.id,
      round,
      quali,
      finish,
      dnf,
      dnfReason: (ctx.options.dnf_reason as string | undefined)?.trim() || null,
      fastestLap: Boolean(ctx.options.fastest_lap),
      pointsOverride,
      sprintFinish,
    },
    table
  );
  if ("error" in saved) {
    console.error("[set-result] save failed:", saved.error);
    return { content: `Something went wrong saving the result: ${saved.error}`, ephemeral: true };
  }

  const finishLabel = dnf ? "DNF" : `P${finish}`;
  const warning =
    pointsOverride === null && table.byPosition.size === 0
      ? "\nThis league has no points table, so 0 points were awarded. Pass `points` to set them."
      : "";

  const summary =
    `Saved <@${driverDiscordId}>: **${finishLabel}** in ${round.name} (season ${seasonNumber}), ` +
    `${saved.points} pts${saved.sprintPoints > 0 ? ` + ${saved.sprintPoints} sprint` : ""}.${warning}`;

  // The result is saved. Updating the Discord posts takes several API calls,
  // so acknowledge now and do it in the background (Discord's 3s limit).
  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      await refreshDiscordPosts(leagueId, [{ season: round.season_number, round: round.round_number as number }]);
      return { content: summary };
    },
  };
});

/**
 * Finds a driver from a CSV cell: a Discord ID, or a username / display
 * name (exact match, case-insensitive). Refuses ambiguous matches.
 */
async function findDriverByToken(token: string) {
  const supabase = createAdminClient();
  const cleaned = token.trim().replace(/^@/, "");
  if (!cleaned) return { error: "driver is blank" } as const;

  if (/^\d{15,25}$/.test(cleaned)) {
    const { data, error } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .eq("discord_id", cleaned)
      .limit(1)
      .maybeSingle();
    if (error) return { error: error.message } as const;
    if (!data) return { error: `no driver with Discord ID ${cleaned}` } as const;
    return { driverId: data.id as string } as const;
  }

  const pattern = cleaned.replace(/[\\%_]/g, "\\$&");
  for (const column of ["discord_username", "display_name"] as const) {
    const { data, error } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .ilike(column, pattern)
      .limit(2);
    if (error) return { error: error.message } as const;
    if (data && data.length === 1) return { driverId: data[0].id as string } as const;
    if (data && data.length > 1) return { error: `"${cleaned}" matches more than one driver` } as const;
  }
  return { error: `no driver found for "${cleaned}"` } as const;
}

/**
 * CSV columns (header row required, any order):
 *   driver (Discord ID, or exact username / display name), finish, quali,
 *   dnf (true/false), dnf_reason, fastest_lap (true/false), points
 *   (overrides the points table), sprint_finish
 * Re-importing a driver for the same round overwrites their row.
 */
registerCommand("import-results", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;

  const seasonNumber = toInt(ctx.options.season);
  const roundInput = (ctx.options.round as string | number | undefined)?.toString().trim();
  if (seasonNumber === null || !roundInput) {
    return { content: "season and round are required.", ephemeral: true };
  }

  const division = await resolveDivisionId(leagueId, ctx.options.division as string | undefined);
  if ("error" in division) {
    return { content: division.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }

  const roundResult = await resolveRaceRound(leagueId, seasonNumber, roundInput, division.divisionId);
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const csv = await readCsvAttachment(ctx, "file");
      if ("error" in csv) return { content: csv.error ?? "Couldn't read the CSV." };

      if (!csv.header.includes("driver")) {
        return { content: "The CSV header needs a `driver` column." };
      }
      if (!csv.header.includes("finish") && !csv.header.includes("dnf")) {
        return { content: "The CSV header needs a `finish` column (and optionally `dnf`)." };
      }

      const table = await loadPointsTable(leagueId);
      let saved = 0;
      const errors: string[] = [];

      for (let i = 0; i < csv.records.length; i++) {
        const rec = csv.records[i];
        const line = i + 2;
        try {
          const found = await findDriverByToken(rec.driver ?? "");
          if ("error" in found) throw new Error(found.error);

          const dnf = csvBool(rec.dnf);
          const finish = csvInt(rec.finish, "finish");
          if (!dnf && (finish === null || finish < 1)) throw new Error("finish is blank (mark dnf if they DNF'd)");

          const result = await saveResult(
            {
              leagueId,
              driverId: found.driverId,
              round,
              quali: csvInt(rec.quali, "quali"),
              finish,
              dnf,
              dnfReason: rec.dnf_reason || null,
              fastestLap: csvBool(rec.fastest_lap),
              pointsOverride: csvNumber(rec.points, "points"),
              sprintFinish: csvInt(rec.sprint_finish, "sprint_finish"),
            },
            table
          );
          if ("error" in result) throw new Error(result.error);
          saved++;
        } catch (err) {
          errors.push(`Line ${line}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (saved > 0 && round.round_number != null) {
        await refreshDiscordPosts(leagueId, [{ season: round.season_number, round: round.round_number }]);
      }

      const lines = [`${round.name} (season ${seasonNumber}): ${saved} result(s) saved, ${errors.length} skipped.`];
      if (table.byPosition.size === 0) {
        lines.push("This league has no points table — rows without a `points` value got 0 points.");
      }
      if (errors.length > 0) lines.push("", ...errors.slice(0, 10));
      if (errors.length > 10) lines.push(`…and ${errors.length - 10} more.`);
      return { content: clip(lines.join("\n")) };
    },
  };
});

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/**
 * Sets a driver's TOTAL season points to an exact value by recording an
 * adjustment for the difference between that value and what they currently
 * have (points from results + earlier adjustments). /standings adds the
 * adjustments on top of the live results totals. Every change is its own
 * row, so there's a history and nothing in pitboss.results is edited.
 */
registerCommand("set-standings", async (ctx) => {
  const guard = await ownerGuard(ctx);
  if ("error" in guard) {
    return { content: guard.error ?? "Something went wrong.", ephemeral: true };
  }
  const leagueId = guard.leagueId;

  const driverDiscordId = ctx.options.driver as string | undefined;
  const seasonNumber = toInt(ctx.options.season);
  const targetRaw = ctx.options.points;
  const target = targetRaw === undefined || targetRaw === null ? NaN : Number(targetRaw);
  if (!driverDiscordId || seasonNumber === null || !Number.isFinite(target)) {
    return { content: "driver, season and points are required.", ephemeral: true };
  }

  const season = String(seasonNumber);
  const supabase = createAdminClient();

  const driverResult = await getOrCreateDriver(driverDiscordId, ctx.resolvedUsers[driverDiscordId]?.username);
  if ("error" in driverResult) {
    return { content: `Couldn't resolve that driver: ${driverResult.error}`, ephemeral: true };
  }
  const driverId = driverResult.driver.id;

  const [resultsRes, adjustmentsRes] = await Promise.all([
    supabase
      .schema("pitboss")
      .from("results")
      .select("points_earned, sprint_points_earned")
      .eq("league_id", leagueId)
      .eq("season", season)
      .eq("driver_id", driverId),
    supabase
      .schema("pitboss")
      .from("standings_adjustments")
      .select("points_delta")
      .eq("league_id", leagueId)
      .eq("season", season)
      .eq("driver_id", driverId),
  ]);

  if (resultsRes.error || adjustmentsRes.error) {
    const message = resultsRes.error?.message ?? adjustmentsRes.error?.message ?? "unknown error";
    console.error("[set-standings] lookup failed:", message);
    return { content: `Something went wrong reading current points: ${message}`, ephemeral: true };
  }

  const fromResults = (resultsRes.data ?? []).reduce(
    (sum, r) => sum + Number(r.points_earned ?? 0) + Number(r.sprint_points_earned ?? 0),
    0
  );
  const fromAdjustments = (adjustmentsRes.data ?? []).reduce((sum, a) => sum + Number(a.points_delta ?? 0), 0);
  const current = round2(fromResults + fromAdjustments);
  const delta = round2(target - current);

  if (delta === 0) {
    return { content: `<@${driverDiscordId}> already has ${current} points in season ${season}. No change.`, ephemeral: true };
  }

  const owner = await getOrCreateDriver(ctx.discordUserId, ctx.resolvedUsers[ctx.discordUserId]?.username);
  const reason = (ctx.options.reason as string | undefined)?.trim() || "Manual standings set by owner";

  const { error: insertError } = await supabase
    .schema("pitboss")
    .from("standings_adjustments")
    .insert({
      league_id: leagueId,
      season,
      driver_id: driverId,
      points_delta: delta,
      reason,
      created_by: "error" in owner ? null : owner.driver.id,
    });
  if (insertError) {
    console.error("[set-standings] insert failed:", insertError);
    return { content: `Something went wrong saving the adjustment: ${insertError.message}`, ephemeral: true };
  }

  const summary =
    `Set <@${driverDiscordId}> to **${target}** points for season ${season} ` +
    `(was ${current}, adjustment ${delta > 0 ? "+" : ""}${delta}).`;

  // Adjustments don't touch pitboss.results, so force the standings posts
  // to refresh. Done in the background to stay inside Discord's 3s limit.
  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      await refreshDiscordPosts(leagueId, [], { force: true });
      return { content: summary };
    },
  };
});
