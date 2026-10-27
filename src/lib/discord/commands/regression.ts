// regression.ts
//
// /regression set | list | preview | apply
//
// Off-season DDV regression. Rates are per league and per tier, stored in
// pitboss.ddv_regression_config (no rates are assumed: a tier with no
// config row is skipped). Engine: pitboss.regress_ddv(league, season,
// dry_run, actor), which also applies an extra decay per
// extended_inactivity_seasons and logs off_season_decay /
// extended_inactivity_decay rows to driver_ddv_history. It will not
// apply twice for the same driver and season. Owner/co-owner only.
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

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

function money(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? `$${Math.round(v).toLocaleString("en-US")}` : "—";
}

registerCommand("regression_set", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };
  const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
  if (denied) return { content: denied, ephemeral: true };

  const tier = (ctx.options.tier as string | undefined)?.trim();
  const decay = ctx.options.decay_pct as number | undefined;
  const inactivity = ctx.options.inactivity_pct as number | undefined;
  if (!tier) return { content: "Specify a tier.", ephemeral: true };
  if (decay === undefined || decay < 0 || decay > 100) {
    return { content: "decay_pct must be between 0 and 100.", ephemeral: true };
  }
  if (inactivity !== undefined && (inactivity < 0 || inactivity > 100)) {
    return { content: "inactivity_pct must be between 0 and 100.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .schema("pitboss")
    .from("ddv_regression_config")
    .select("id, tier, inactivity_extra_pct")
    .eq("league_id", leagueId)
    .ilike("tier", tier)
    .maybeSingle();

  const row = {
    offseason_decay_pct: decay,
    inactivity_extra_pct: inactivity ?? existing?.inactivity_extra_pct ?? 0,
    updated_by: ctx.discordUserId,
    updated_at: new Date().toISOString(),
  };
  const { error } = existing
    ? await supabase.schema("pitboss").from("ddv_regression_config").update(row).eq("id", existing.id)
    : await supabase.schema("pitboss").from("ddv_regression_config").insert({ league_id: leagueId, tier, ...row });

  if (error) {
    console.error("[regression_set] failed:", error);
    return { content: `Couldn't save: ${error.message}`, ephemeral: true };
  }
  return {
    content: `Regression for **${existing?.tier ?? tier}**: ${decay}% off-season decay, ${row.inactivity_extra_pct}% extra per inactive season.`,
    ephemeral: false,
  };
});

registerCommand("regression_list", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) return { content: "This command must be used in a league channel.", ephemeral: true };
  const denied = await requireLeagueOwner(leagueId, ctx.discordUserId);
  if (denied) return { content: denied, ephemeral: true };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("ddv_regression_config")
    .select("tier, offseason_decay_pct, inactivity_extra_pct")
    .eq("league_id", leagueId)
    .order("tier");
  if (error) return { content: `Couldn't load config: ${error.message}`, ephemeral: true };
  if (!data || data.length === 0) {
    return { content: "No regression rates set for this league. Use `/regression set`.", ephemeral: true };
  }
  const lines = ["**Regression rates**", ...data.map((r) => `${r.tier}: ${r.offseason_decay_pct}% decay · ${r.inactivity_extra_pct}% per inactive season`)];
  return { content: lines.join("\n"), ephemeral: true };
});

function runHandler(dryRun: boolean) {
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

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .schema("pitboss")
      .rpc("regress_ddv", { p_league: leagueId, p_season: season, p_dry_run: dryRun, p_actor: ctx.discordUserId });
    if (error) {
      console.error("[regression] failed:", error);
      return { content: `Couldn't run regression: ${error.message}`, ephemeral: true };
    }
    const rows = (data ?? []) as Array<{
      driver_id: string; tier: string | null; ddv_before: number; ddv_after: number;
      delta: number; decay_pct: number; inactivity_pct: number; skipped: string | null;
    }>;
    if (rows.length === 0) return { content: "No DDV records in this league.", ephemeral: true };

    const ids = rows.map((r) => r.driver_id);
    const { data: drivers } = await supabase.schema("pitboss").from("drivers").select("id, display_name, discord_username").in("id", ids);
    const names = new Map((drivers ?? []).map((d) => [d.id, d.display_name ?? d.discord_username ?? "Unknown"]));

    const changed = rows.filter((r) => !r.skipped && Number(r.delta) !== 0);
    const skipped = rows.filter((r) => r.skipped);
    const total = changed.reduce((s, r) => s + Number(r.delta), 0);

    const head = dryRun
      ? `**Regression preview — season ${season}** (dry run, nothing saved)`
      : `**Regression applied — season ${season}**`;
    const lines = [
      head,
      `${changed.length} drivers change · ${skipped.length} skipped · net ${money(total)}`,
      ...changed.map(
        (r) =>
          `${names.get(r.driver_id) ?? r.driver_id.slice(0, 8)} (${r.tier ?? "—"}): ${money(r.ddv_before)} → ${money(r.ddv_after)} ` +
          `(-${r.decay_pct}%${Number(r.inactivity_pct) > 0 ? ` -${r.inactivity_pct}% inactivity` : ""})`
      ),
    ];
    if (skipped.length > 0) {
      const reasons = [...new Set(skipped.map((r) => r.skipped))];
      lines.push(`Skipped: ${reasons.join("; ")}`);
    }
    if (dryRun) lines.push("Run `/regression apply` to commit.");
    return { content: clip(lines), ephemeral: dryRun };
  };
}

registerCommand("regression_preview", runHandler(true));
registerCommand("regression_apply", runHandler(false));
