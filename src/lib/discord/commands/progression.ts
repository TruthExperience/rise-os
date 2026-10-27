// progression.ts
//
// /progression preview | propose | list | approve | reject | decline | apply | finalize
//
// Thin Discord front-end over the pitboss.* progression functions
// (migration progression_v4_finalize):
//   calc_progression(p_league, p_season, p_dry_run)      -> TABLE of proposed moves
//   decide_progression(p_proposal, p_decision, p_actor)  -> progression_proposals row
//   apply_progression(p_proposal, p_dispute_hours, p_dry_run) -> jsonb
//   finalize_progression_conversion(p_conversion, p_dry_run)  -> jsonb
//
// Safety: preview never writes. apply and finalize default to dry_run=true;
// the caller must pass dry_run:false to commit. Owner/co-owner only,
// matching requireLeagueOwner in ddv.ts / cap.ts.
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

type Supa = ReturnType<typeof createAdminClient>;

const MAX_LEN = 1900;

async function requireLeagueOwner(leagueId: string, discordUserId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  if (!driver) return "Only the league owner or co-owner can do that.";

  const { data: role } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_owner, is_co_owner")
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!role?.is_owner && !role?.is_co_owner) return "Only the league owner or co-owner can do that.";
  return null;
}

async function driverNames(supabase: Supa, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id, display_name, discord_username")
    .in("id", ids);
  for (const d of data ?? []) map.set(d.id, d.display_name ?? d.discord_username ?? "Unknown");
  return map;
}

function clip(lines: string[]): string {
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    if (len + lines[i].length + 1 > MAX_LEN) {
      out.push(`…and ${lines.length - i} more`);
      break;
    }
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  return out.join("\n");
}

function fmtMoney(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toLocaleString("en-US")}` : "—";
}

// Accepts a full UUID or an 8+ char prefix of a proposal in this league.
async function resolveProposalId(
  supabase: Supa,
  leagueId: string,
  input: string
): Promise<{ id?: string; error?: string }> {
  const raw = input.trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    const { data } = await supabase
      .schema("pitboss")
      .from("progression_proposals")
      .select("id")
      .eq("id", raw)
      .eq("league_id", leagueId)
      .maybeSingle();
    return data ? { id: data.id } : { error: "No proposal with that ID in this league." };
  }
  if (!/^[0-9a-f]{8,}$/.test(raw)) return { error: "Give the full proposal ID or its first 8 characters." };

  const { data, error } = await supabase
    .schema("pitboss")
    .from("progression_proposals")
    .select("id")
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return { error: `Couldn't look up proposals: ${error.message}` };
  const matches = (data ?? []).filter((r) => r.id.startsWith(raw));
  if (matches.length === 0) return { error: "No proposal matches that ID in this league." };
  if (matches.length > 1) return { error: "That prefix matches more than one proposal. Use more characters." };
  return { id: matches[0].id };
}

// --- preview / propose ------------------------------------------------------

function calcHandler(dryRun: boolean) {
  return async (ctx: {
    leagueId: string | undefined;
    discordUserId: string;
    options: Record<string, unknown>;
  }) => {
    const leagueId = ctx.leagueId;
    if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };

    const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
    if (denied) return { content: denied, ephemeral: true };

    const season = (ctx.options.season as string | undefined)?.trim();
    if (!season) return { content: "Specify a season.", ephemeral: true };

    return {
      defer: true as const,
      ephemeral: dryRun,
      background: async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .schema("pitboss")
          .rpc("calc_progression", { p_league: leagueId, p_season: season, p_dry_run: dryRun });

        if (error) {
          console.error("[progression] calc failed:", error);
          return { content: `Couldn't calculate progression: ${error.message}` };
        }
        const rows = (data ?? []) as Array<{
          driver_id: string;
          from_division: string | null;
          to_division: string | null;
          action: string;
          division_rank: number;
          division_size: number;
          points: number;
          starts: number;
          ddv: number;
        }>;
        if (rows.length === 0) return { content: `No progression moves for season ${season}.` };

        const names = await driverNames(supabase, rows.map((r) => r.driver_id));
        const counts = new Map<string, number>();
        rows.forEach((r) => counts.set(r.action, (counts.get(r.action) ?? 0) + 1));
        const summary = [...counts.entries()].map(([a, n]) => `${a}: ${n}`).join(" · ");

        const head = dryRun
          ? `**Progression preview — season ${season}** (dry run, nothing saved)`
          : `**Progression proposals written — season ${season}**`;
        const lines = rows.map(
          (r) =>
            `${names.get(r.driver_id) ?? r.driver_id.slice(0, 8)} — ${r.action}` +
            ` (${r.from_division ?? "—"} → ${r.to_division ?? "—"}, rank ${r.division_rank}/${r.division_size}, ` +
            `${r.points} pts, ${r.starts} starts, DDV ${fmtMoney(r.ddv)})`
        );
        const tail = dryRun
          ? "Run `/progression propose` to save these."
          : "Review with `/progression list`, then `/progression approve`.";
        return { content: clip([head, summary, ...lines]) + `\n${tail}` };
      },
    };
  };
}

registerCommand("progression_preview", calcHandler(true));
registerCommand("progression_propose", calcHandler(false));

// --- list -------------------------------------------------------------------

registerCommand("progression_list", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };

  const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
  if (denied) return { content: denied, ephemeral: true };

  const supabase = createAdminClient();
  const status = (ctx.options.status as string | undefined) ?? "proposed";
  const season = ctx.options.season as string | undefined;

  let q = supabase
    .schema("pitboss")
    .from("progression_proposals")
    .select("id, season, driver_id, action, from_division_code, to_division_code, status, conversion_id")
    .eq("league_id", leagueId)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(40);
  if (season) q = q.eq("season", season);

  const { data, error } = await q;
  if (error) {
    console.error("[progression_list] failed:", error);
    return { content: `Couldn't load proposals: ${error.message}`, ephemeral: true };
  }
  if (!data || data.length === 0) {
    return { content: `No ${status} proposals${season ? ` for season ${season}` : ""}.`, ephemeral: true };
  }

  const names = await driverNames(supabase, data.map((r) => r.driver_id));
  const lines = data.map(
    (r) =>
      `\`${r.id.slice(0, 8)}\` ${names.get(r.driver_id) ?? "Unknown"} — ${r.action} ` +
      `(${r.from_division_code ?? "—"} → ${r.to_division_code ?? "—"}, S${r.season})` +
      (r.conversion_id ? ` · conv \`${r.conversion_id.slice(0, 8)}\`` : "")
  );
  return { content: clip([`**Progression proposals — ${status}**`, ...lines]), ephemeral: true };
});

// --- approve / reject / decline ---------------------------------------------

function decideHandler(decision: "approved" | "rejected" | "declined") {
  return async (ctx: {
    leagueId: string | undefined;
    discordUserId: string;
    options: Record<string, unknown>;
  }) => {
    const leagueId = ctx.leagueId;
    if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };

    const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
    if (denied) return { content: denied, ephemeral: true };

    const input = ctx.options.proposal as string | undefined;
    if (!input) return { content: "Specify a proposal ID.", ephemeral: true };

    const supabase = createAdminClient();
    const resolved = await resolveProposalId(supabase, leagueId, input);
    if (!resolved.id) return { content: resolved.error ?? "Couldn't resolve that proposal.", ephemeral: true };

    const { data, error } = await supabase
      .schema("pitboss")
      .rpc("decide_progression", {
        p_proposal: resolved.id,
        p_decision: decision,
        p_actor: ctx.discordUserId,
      })
      .single<{ id: string; driver_id: string; action: string; to_division_code: string | null }>();

    if (error) {
      console.error("[progression_decide] failed:", error);
      return { content: `Couldn't record that: ${error.message}`, ephemeral: true };
    }

    const names = await driverNames(supabase, [data.driver_id]);
    const next = decision === "approved" ? "\nNext: `/progression apply` (dry run first)." : "";
    return {
      content: `Proposal \`${data.id.slice(0, 8)}\` for **${names.get(data.driver_id) ?? "driver"}** (${data.action} → ${data.to_division_code ?? "—"}) marked **${decision}**.${next}`,
      ephemeral: false,
    };
  };
}

registerCommand("progression_approve", decideHandler("approved"));
registerCommand("progression_reject", decideHandler("rejected"));
registerCommand("progression_decline", decideHandler("declined"));

// --- apply ------------------------------------------------------------------

registerCommand("progression_apply", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };

  const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
  if (denied) return { content: denied, ephemeral: true };

  const input = ctx.options.proposal as string | undefined;
  if (!input) return { content: "Specify a proposal ID.", ephemeral: true };

  // Default is a dry run. Only an explicit dry_run:false commits.
  const dryRun = (ctx.options.dry_run as boolean | undefined) !== false;
  const disputeHours = ctx.options.dispute_hours as number | undefined;

  const supabase = createAdminClient();
  const resolved = await resolveProposalId(supabase, leagueId, input);
  if (!resolved.id) return { content: resolved.error ?? "Couldn't resolve that proposal.", ephemeral: true };

  const { data, error } = await supabase.schema("pitboss").rpc("apply_progression", {
    p_proposal: resolved.id,
    p_dispute_hours: disputeHours ?? null,
    p_dry_run: dryRun,
  });
  if (error) {
    console.error("[progression_apply] failed:", error);
    return { content: `Couldn't apply: ${error.message}`, ephemeral: true };
  }

  const r = (data ?? {}) as Record<string, any>;
  const tag = dryRun ? "**Dry run — nothing changed.**" : "**Applied.**";
  const lines: string[] = [tag];

  if (r.path === "conversion") {
    lines.push(
      `Contract conversion (${r.scenario}): ${r.from_division} → ${r.to_division}`,
      `Original ${fmtMoney(r.original_value)} · DDV ${fmtMoney(r.ddv)} · Converted ${fmtMoney(r.converted_value)}`,
      `New floor ${fmtMoney(r.new_floor)} · ceiling ${fmtMoney(r.new_ceiling)}` +
        (r.hardship_applied ? " · hardship floor applied" : "")
    );
    lines.push(
      dryRun
        ? "Re-run with `dry_run: False` to create the provisional conversion."
        : `Provisional conversion \`${String(r.conversion_id).slice(0, 8)}\` created. After the dispute window, run \`/progression finalize\`.`
    );
  } else if (r.path === "division_members") {
    lines.push("Driver moved directly between divisions (no contract conversion).");
    if (dryRun) lines.push("Re-run with `dry_run: False` to commit.");
  } else {
    lines.push(`Roster-only move: ${r.from_division ?? "—"} → ${r.to_division ?? "—"} (no active contract).`);
    if (dryRun) lines.push("Re-run with `dry_run: False` to commit.");
  }
  return { content: clip(lines), ephemeral: dryRun };
});

// --- finalize ---------------------------------------------------------------

registerCommand("progression_finalize", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };

  const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
  if (denied) return { content: denied, ephemeral: true };

  const input = ctx.options.conversion as string | undefined;
  if (!input) return { content: "Specify a conversion ID.", ephemeral: true };

  const dryRun = (ctx.options.dry_run as boolean | undefined) !== false;
  const supabase = createAdminClient();

  // Accept full UUID or 8+ char prefix, scoped to this league.
  const raw = input.trim().toLowerCase();
  let conversionId: string | undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    conversionId = raw;
  } else if (/^[0-9a-f]{8,}$/.test(raw)) {
    const { data } = await supabase
      .schema("pitboss")
      .from("contract_conversions")
      .select("id")
      .eq("league_id", leagueId)
      .eq("status", "provisional");
    const matches = (data ?? []).filter((c) => c.id.startsWith(raw));
    if (matches.length !== 1) {
      return { content: matches.length === 0 ? "No provisional conversion matches that ID." : "That prefix is ambiguous.", ephemeral: true };
    }
    conversionId = matches[0].id;
  } else {
    return { content: "Give the full conversion ID or its first 8 characters.", ephemeral: true };
  }

  // Confirm it belongs to this league before touching it.
  const { data: conv } = await supabase
    .schema("pitboss")
    .from("contract_conversions")
    .select("id")
    .eq("id", conversionId)
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!conv) return { content: "No conversion with that ID in this league.", ephemeral: true };

  const { data, error } = await supabase
    .schema("pitboss")
    .rpc("finalize_progression_conversion", { p_conversion: conversionId, p_dry_run: dryRun });
  if (error) {
    console.error("[progression_finalize] failed:", error);
    return { content: `Couldn't finalize: ${error.message}`, ephemeral: true };
  }

  const r = (data ?? {}) as Record<string, any>;
  const lines = [
    dryRun ? "**Dry run — nothing changed.**" : "**Conversion finalized.**",
    `Scenario ${r.scenario} → ${r.new_division}${r.hybrid_buffer ? " (hybrid buffer, 2 grace sessions)" : ""}`,
    `New value ${fmtMoney(r.new_value)} · floor ${fmtMoney(r.new_floor)} · ceiling ${fmtMoney(r.new_ceiling)}`,
  ];
  if (dryRun) lines.push("Re-run with `dry_run: False` to commit.");
  return { content: clip(lines), ephemeral: dryRun };
});
