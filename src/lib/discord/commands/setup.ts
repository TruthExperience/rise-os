File: src/lib/discord/commands/setup.ts
//
// Self-serve replacement for the manual Supabase work an admin used to need
// from us for every new league (see e.g. the Absolut Vodka F2 setup: a
// hand-written INSERT into rise_os.leagues with the right Discord IDs).
//
// Most servers already have their channels set up before PitBoss ever
// joins, so this doesn't try to create or name-pattern-guess channels the
// way pitboss-guardian's join-time provisioning does — it lets the admin
// point directly at whichever existing channels they want, via Discord's
// native channel-picker option type (CHANNEL, type 7). That also means
// this command needs no Discord bot token / REST calls at all: Discord
// resolves the picked channel to its ID for us, and everything else is a
// Supabase write.
//
// Works standalone — doesn't require pitboss-guardian to have already
// created a 'trial' row for this guild. If one exists (from auto-join
// provisioning), this finalizes it; if not, this creates it outright.
//
// PATCH (2026-09-17): rise_os.leagues and pitboss.leagues had drifted out
// of sync — this command only ever wrote to rise_os.leagues, so any league
// set up through /setup existed there but had no row in pitboss.leagues.
// pitboss.driver_leagues.league_id has a FK against pitboss.leagues, so
// every permission check in checkin.ts (getLeagueMembership/hasAnyFlag)
// silently failed for such leagues with "you don't have permission" even
// for someone who should be an owner/admin — there was simply no row to
// grant flags against. World Series Championship hit this: it existed in
// rise_os.leagues only, until backfilled by hand.
//
// This command only ever sets sport to "sim_racing" (it has no sport
// option), so every league it provisions is, by definition, a sim league
// that pitboss's F1-flavored financial/driver/permission schema applies
// to. After the rise_os.leagues write succeeds, we now also upsert the
// same row into pitboss.leagues (same id, so the FK from
// pitboss.driver_leagues resolves immediately). This is intentionally
// scoped to sim_racing — the cfb dynasty leagues (Rise Dynasty, Rise
// HBCUKingz Dynasty) are provisioned through a different path and don't
// use pitboss's driver/permission tables, so we don't want this command
// silently pulling them into pitboss.leagues if it's ever extended to
// take a sport option.
//
// Mirror failure is logged but non-fatal to the user-facing response —
// the rise_os.leagues write (the source of truth for Discord-side config)
// already succeeded, and a failed mirror just means pitboss-side
// permission checks won't resolve this league until the mirror is
// retried, not that /setup itself failed.

import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

// Discord permission bit for ADMINISTRATOR. registry.ts's CommandContext
// doc comment confirms Discord always includes this for the guild owner
// regardless of roles, so checking this bit alone covers "owner or admin".
const ADMINISTRATOR_BIT = 1n << 3n;

function slugifyGuildName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return base || "league";
}

function currencyCodeFromName(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  const code = words
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 5);

  return code || "TRL";
}

// Mirrors a rise_os.leagues row into pitboss.leagues so that
// pitboss.driver_leagues (and anything else FK'd against pitboss.leagues —
// permission checks, wallets, DDV, contracts, etc.) can resolve this
// league immediately. Only the columns that actually exist on both tables
// are carried over; pitboss.leagues has no discord_ticket_category_id /
// discord_steward_role_id / etc. columns, so those stay rise_os-only.
async function mirrorToPitbossLeagues(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string
) {
  const { data: riseOsLeague, error: fetchError } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select(
      "id, name, slug, sport, commissioner_id, discord_server_id, logo_url, season_count, is_public, created_at, updated_at, pitboss_status, isolated"
    )
    .eq("id", leagueId)
    .single();

  if (fetchError || !riseOsLeague) {
    console.error("[setup] failed to re-read rise_os.leagues row for pitboss mirror:", fetchError);
    return;
  }

  // Scoped to sim leagues only — see PATCH note at top of file. If this
  // command is ever extended to provision cfb/other-sport leagues, they
  // should NOT land in pitboss.leagues, since pitboss's schema is
  // sim-racing-specific (drivers, DDV, race checkins, etc.).
  if (riseOsLeague.sport !== "sim_racing") return;

  const { error: mirrorError } = await supabase
    .schema("pitboss")
    .from("leagues")
    .upsert(riseOsLeague, { onConflict: "id" });

  if (mirrorError) {
    console.error("[setup] failed to mirror league into pitboss.leagues:", mirrorError);
    // Not fatal to the user — rise_os.leagues (the Discord-config source
    // of truth) already wrote successfully. A failed mirror just means
    // pitboss.driver_leagues-based permission checks won't resolve this
    // league until the mirror is retried. Logged for follow-up.
  }
}

registerCommand("setup", async (ctx) => {
  if (!ctx.guildId) {
    return { content: "This command must be used in a server, not a DM.", ephemeral: true };
  }

  const hasAdmin = (BigInt(ctx.memberPermissions || "0") & ADMINISTRATOR_BIT) !== 0n;
  if (!hasAdmin) {
    return { content: "Only a server administrator can run `/setup`.", ephemeral: true };
  }

  // Discord resolves a CHANNEL-type option straight to the channel's ID —
  // no separate resolved-lookup needed the way ATTACHMENT options require,
  // since the ID is all rise_os.leagues actually stores.
  const nameInput = (ctx.options.name as string | undefined)?.trim();
  const fiaCategoryId = ctx.options.fia_category as string | undefined;
  const reportsChannelId = ctx.options.reports_channel as string | undefined;
  const transcriptChannelId = ctx.options.transcript_channel as string | undefined;
  const financialSystem = Boolean(ctx.options.financial_system);

  if (!nameInput) {
    return { content: "`name` is required.", ephemeral: true };
  }

  if (!fiaCategoryId || !reportsChannelId) {
    return {
      content: "`fia_category` and `reports_channel` are required — pick your existing channels for both.",
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();

  const { data: existing, error: existingError } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, pitboss_status, discord_steward_role_id, discord_transcript_channel_id")
    .eq("discord_server_id", ctx.guildId)
    .maybeSingle();

  if (existingError) {
    return {
      content: `Something went wrong checking for an existing league: ${existingError.message}`,
      ephemeral: true,
    };
  }

  if (existing && existing.pitboss_status === "active") {
    return {
      content: `This server is already set up as **${existing.name}** and active. Ping the PitBoss admin if channels need to change.`,
      ephemeral: true,
    };
  }

  const slug = slugifyGuildName(nameInput);

  const payload = {
    discord_server_id: ctx.guildId,
    name: nameInput,
    slug,
    sport: "sim_racing",
    pitboss_status: "active",
    currency_code: currencyCodeFromName(nameInput),
    discord_ticket_category_id: fiaCategoryId,
    discord_incident_channel_id: reportsChannelId,
    // Keep whatever guardian may have already found/set if this option is
    // omitted, rather than clobbering it with null.
    discord_transcript_channel_id: transcriptChannelId ?? existing?.discord_transcript_channel_id ?? null,
    discord_steward_role_id: existing?.discord_steward_role_id ?? null,
    updated_at: new Date().toISOString(),
  };

  let leagueId: string | undefined = existing?.id;

  const { data: writeResult, error: writeError } = existing
    ? await supabase.schema("rise_os").from("leagues").update(payload).eq("id", existing.id).select("id").single()
    : await supabase.schema("rise_os").from("leagues").insert(payload).select("id").single();

  if (writeError) {
    if (writeError.message.toLowerCase().includes("duplicate key")) {
      return {
        content: `"${nameInput}" (slug \`${slug}\`) is already taken by another league — try a more specific name.`,
        ephemeral: true,
      };
    }
    return { content: `Something went wrong setting up this league: ${writeError.message}`, ephemeral: true };
  }

  leagueId = writeResult?.id ?? leagueId;

  // Mirror into pitboss.leagues (sim leagues only) so FK-dependent tables
  // like pitboss.driver_leagues can resolve this league right away,
  // instead of leaving it invisible to pitboss-side permission checks
  // until someone notices and backfills it by hand.
  if (leagueId) {
    await mirrorToPitbossLeagues(supabase, leagueId);
  }

  const notes = [
    `**${nameInput}** is now set up and active.`,
    `FIA category: <#${fiaCategoryId}> · Reports: <#${reportsChannelId}>${
      transcriptChannelId ? ` · Transcripts: <#${transcriptChannelId}>` : ""
    }`,
  ];

  if (financialSystem) {
    notes.push(
      "Financial system requested — salary cap / wallet config isn't set up by this command yet, since it needs specific numbers (cap, apron, starting wallet). Ping the PitBoss admin to configure it."
    );
  } else {
    notes.push("No financial system — matches how AWC/WSC run.");
  }

  if (!existing?.discord_steward_role_id) {
    notes.push(
      "No steward role linked yet — that gets picked up automatically the next time pitboss-guardian's security scan runs, or ping the PitBoss admin to set it manually."
    );
  }

  return { content: notes.join(" "), ephemeral: false };
});
