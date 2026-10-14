// File: src/lib/discord/commands/setup.ts
//
// Self-serve replacement for the manual Supabase work an admin used to need
// from us for every new league (see e.g. the Absolut Vodka F2 setup: a
// hand-written INSERT into rise_os.leagues with the right Discord IDs).
//
// 2026-10-11 REWORK — auto-detect + league-optional:
//
//  1. Registered with { leagueOptional: true }. The router hard-fails every
//     command with "not linked to a league" when no rise_os.leagues row
//     matches the guild — which meant /setup could never run on a server
//     that had no row yet (VRC hit exactly this). /setup is the command
//     that creates the row, so it has to be allowed through with no league.
//
//  2. Reads the server's channels and roles through the Discord REST API
//     (bot token) and fills in anything not explicitly provided, matching
//     by name. Resolution order per setting:
//         explicit slash option  >  value already saved  >  auto-detected
//     so re-running /setup is safe: it only fills gaps and never overwrites
//     a saved value unless the admin passes that option explicitly.
//
//  3. Re-running on an already-active league is allowed (it used to refuse
//     with "ping the PitBoss admin"). That was the only way to fix a wrong
//     channel without hand-written SQL.
//
//  4. Now also manages the appeals channel and steward role (previously
//     /setup never set either, so every league it created had both empty).
//
//  5. Now also manages the DRIVER SIGNUP channel (signup_channel). It lives
//     in pitboss.leagues.signup_channel_id (not rise_os.leagues), because
//     that is where the signup code (src/lib/discord-signups.ts) reads it.
//     Auto-detect picks a text channel whose name contains "signup" or
//     "sign-up" (e.g. #driver-signups). It is optional: a league that
//     doesn't run signups can ignore it.
//
// Everything else is the same as before: sim_racing only, writes
// rise_os.leagues (source of truth for Discord config) and then mirrors the
// shared columns into pitboss.leagues so FK-dependent pitboss tables
// (driver_leagues, wallets, contracts, ...) resolve immediately.
//
// Mirror failure is logged but non-fatal to the user-facing response.
//
// NOTE: the slash command definition on Discord's side must be updated to
// match: name / fia_category / reports_channel must NOT be required, and
// appeals_channel (CHANNEL, type 7), steward_role (ROLE, type 8) and
// signup_channel (CHANNEL, type 7, text channels only) must be added. Until
// it is, Discord will keep forcing the old required options and won't show
// the signup_channel picker (auto-detect still works without it).

import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

// Discord permission bit for ADMINISTRATOR. registry.ts's CommandContext
// doc comment confirms Discord always includes this for the guild owner
// regardless of roles, so checking this bit alone covers "owner or admin".
const ADMINISTRATOR_BIT = 1n << 3n;

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_LOOKUP_TIMEOUT_MS = 5000;

// Discord channel types we care about.
const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_CATEGORY = 4;

// Name patterns used for auto-detection. Matched case-insensitively against
// the whole channel/role name, so decorated names like "『📋』incident-reports"
// still match.
const TICKET_CATEGORY_RE = /ticket|fia|steward/;
const INCIDENT_CHANNEL_RE = /incident|report/;
const TRANSCRIPT_CHANNEL_RE = /transcript/;
const APPEALS_CHANNEL_RE = /appeal/;
const SIGNUP_CHANNEL_RE = /sign-?ups?/;
const STEWARD_ROLE_RE = /steward|fia/;

interface GuildChannel {
  id: string;
  name: string;
  type: number;
  position?: number;
}

interface GuildRole {
  id: string;
  name: string;
  position?: number;
  managed?: boolean;
}

interface GuildInfo {
  name: string | null;
  channels: GuildChannel[];
  roles: GuildRole[];
}

interface SetupInput {
  name?: string;
  fiaCategory?: string;
  reportsChannel?: string;
  transcriptChannel?: string;
  appealsChannel?: string;
  signupChannel?: string;
  stewardRole?: string;
  financialSystem: boolean;
}

interface Detected {
  id: string;
  name: string;
  totalMatches: number;
}

type Source = "chosen" | "kept" | "detected";

interface Resolved {
  id: string | null;
  source: Source | null;
  detected?: Detected;
}

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

// The Next.js app's bot token env var. PITBOSS_DISCORD_BOT_TOKEN is what the
// pitboss-proxy worker uses; DISCORD_BOT_TOKEN is the common fallback name.
// If neither is set on the Vercel project, auto-detect is skipped and the
// reply says so.
function getBotToken(): string | null {
  return process.env.PITBOSS_DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN ?? null;
}

async function discordGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${DISCORD_API_BASE}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(DISCORD_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[setup] Discord GET ${path} failed:`, res.status, await res.text());
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[setup] Discord GET ${path} threw:`, err);
    return null;
  }
}

async function fetchGuildInfo(guildId: string): Promise<GuildInfo | null> {
  const token = getBotToken();
  if (!token) return null;

  const [guild, channels, roles] = await Promise.all([
    discordGet<{ name: string }>(`/guilds/${guildId}`, token),
    discordGet<GuildChannel[]>(`/guilds/${guildId}/channels`, token),
    discordGet<GuildRole[]>(`/guilds/${guildId}/roles`, token),
  ]);

  if (!guild && !channels && !roles) return null;

  return {
    name: guild?.name ?? null,
    channels: channels ?? [],
    roles: roles ?? [],
  };
}

// Returns the first (lowest-position) item whose name matches, plus how many
// matched in total so the reply can flag an ambiguous pick.
function detectByName<T extends { id: string; name: string; position?: number }>(
  items: T[],
  include: RegExp,
  exclude?: RegExp
): Detected | undefined {
  const matches = items
    .filter((item) => {
      const lower = item.name.toLowerCase();
      return include.test(lower) && !(exclude && exclude.test(lower));
    })
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  if (matches.length === 0) return undefined;
  return { id: matches[0].id, name: matches[0].name, totalMatches: matches.length };
}

function resolveSetting(
  chosen: string | undefined,
  kept: string | null | undefined,
  detected: Detected | undefined
): Resolved {
  if (chosen) return { id: chosen, source: "chosen" };
  if (kept) return { id: kept, source: "kept" };
  if (detected) return { id: detected.id, source: "detected", detected };
  return { id: null, source: null };
}

// Mirrors a rise_os.leagues row into pitboss.leagues so that
// pitboss.driver_leagues (and anything else FK'd against pitboss.leagues —
// permission checks, wallets, DDV, contracts, etc.) can resolve this
// league immediately. Only the columns that actually exist on both tables
// are carried over; pitboss.leagues has no discord_ticket_category_id /
// discord_steward_role_id / etc. columns, so those stay rise_os-only.
//
// signup_channel_id is NOT in this column list on purpose, so a mirror never
// overwrites it. It is written separately by saveSignupChannel() below.
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

  // Scoped to sim leagues only. If this command is ever extended to
  // provision cfb/other-sport leagues, they should NOT land in
  // pitboss.leagues, since pitboss's schema is sim-racing-specific
  // (drivers, DDV, race checkins, etc.).
  if (riseOsLeague.sport !== "sim_racing") return;

  const { error: mirrorError } = await supabase
    .schema("pitboss")
    .from("leagues")
    .upsert(riseOsLeague, { onConflict: "id" });

  if (mirrorError) {
    console.error("[setup] failed to mirror league into pitboss.leagues:", mirrorError);
    // Not fatal to the user — rise_os.leagues already wrote successfully.
  }
}

// Writes the driver signup channel onto pitboss.leagues. Must run AFTER the
// mirror, so the pitboss.leagues row exists on a brand-new league. Returns
// false if the write failed (logged; the reply says so).
async function saveSignupChannel(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  channelId: string
): Promise<boolean> {
  const { error } = await supabase
    .schema("pitboss")
    .from("leagues")
    .update({ signup_channel_id: channelId })
    .eq("id", leagueId);

  if (error) {
    console.error("[setup] failed to save signup_channel_id:", error);
    return false;
  }
  return true;
}

function sourceLabel(r: Resolved): string {
  if (r.source === "chosen") return "you picked this";
  if (r.source === "kept") return "already saved";
  if (r.source === "detected" && r.detected) {
    return r.detected.totalMatches > 1
      ? `auto-detected, ${r.detected.totalMatches} matches — rerun with the option to change it`
      : "auto-detected";
  }
  return "";
}

function settingLine(label: string, mention: string | null, r: Resolved, missingHint: string): string {
  if (!r.id || !mention) return `⚠️ ${label}: not found — ${missingHint}`;
  return `✅ ${label}: ${mention} (${sourceLabel(r)})`;
}

async function runSetup(guildId: string, input: SetupInput): Promise<string> {
  const supabase = createAdminClient();

  const { data: existing, error: existingError } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select(
      "id, name, slug, discord_ticket_category_id, discord_incident_channel_id, discord_transcript_channel_id, discord_appeals_channel_id, discord_steward_role_id"
    )
    .eq("discord_server_id", guildId)
    .maybeSingle();

  if (existingError) {
    return `Something went wrong checking for an existing league: ${existingError.message}`;
  }

  // The signup channel is stored on pitboss.leagues, not rise_os.leagues.
  let keptSignupChannel: string | null = null;
  if (existing) {
    const { data: pitbossLeague } = await supabase
      .schema("pitboss")
      .from("leagues")
      .select("signup_channel_id")
      .eq("id", existing.id)
      .maybeSingle();
    keptSignupChannel =
      ((pitbossLeague as any)?.signup_channel_id as string | null | undefined) ?? null;
  }

  // Read the server. Failure here is not fatal — explicit options still work.
  const info = await fetchGuildInfo(guildId);

  const finalName = input.name ?? existing?.name ?? info?.name ?? null;
  if (!finalName) {
    return "I couldn't read this server's name. Run `/setup` again with the `name` option filled in.";
  }

  const categories = (info?.channels ?? []).filter((c) => c.type === CHANNEL_TYPE_CATEGORY);
  const textChannels = (info?.channels ?? []).filter((c) => c.type === CHANNEL_TYPE_TEXT);
  const roles = (info?.roles ?? []).filter((r) => r.id !== guildId && !r.managed);

  const ticket = resolveSetting(
    input.fiaCategory,
    existing?.discord_ticket_category_id,
    detectByName(categories, TICKET_CATEGORY_RE)
  );
  const incident = resolveSetting(
    input.reportsChannel,
    existing?.discord_incident_channel_id,
    detectByName(textChannels, INCIDENT_CHANNEL_RE, /transcript|appeal/)
  );
  const transcript = resolveSetting(
    input.transcriptChannel,
    existing?.discord_transcript_channel_id,
    detectByName(textChannels, TRANSCRIPT_CHANNEL_RE)
  );
  const appeals = resolveSetting(
    input.appealsChannel,
    existing?.discord_appeals_channel_id,
    detectByName(textChannels, APPEALS_CHANNEL_RE)
  );
  const signup = resolveSetting(
    input.signupChannel,
    keptSignupChannel,
    detectByName(textChannels, SIGNUP_CHANNEL_RE)
  );
  const steward = resolveSetting(
    input.stewardRole,
    existing?.discord_steward_role_id,
    detectByName(roles, STEWARD_ROLE_RE)
  );

  const payload: Record<string, string | null> = {
    discord_server_id: guildId,
    name: finalName,
    sport: "sim_racing",
    pitboss_status: "active",
    discord_ticket_category_id: ticket.id,
    discord_incident_channel_id: incident.id,
    discord_transcript_channel_id: transcript.id,
    discord_appeals_channel_id: appeals.id,
    discord_steward_role_id: steward.id,
    updated_at: new Date().toISOString(),
  };

  // New league: derive slug + currency. Existing league: leave both alone
  // unless the admin explicitly passed a new name.
  if (!existing) {
    payload.slug = slugifyGuildName(finalName);
    payload.currency_code = currencyCodeFromName(finalName);
  } else if (input.name) {
    payload.slug = slugifyGuildName(input.name);
  }

  const { data: writeResult, error: writeError } = existing
    ? await supabase.schema("rise_os").from("leagues").update(payload).eq("id", existing.id).select("id").single()
    : await supabase.schema("rise_os").from("leagues").insert(payload).select("id").single();

  if (writeError) {
    if (writeError.message.toLowerCase().includes("duplicate key")) {
      return `"${finalName}" (slug \`${slugifyGuildName(finalName)}\`) is already taken by another league — rerun with a more specific \`name\`.`;
    }
    return `Something went wrong setting up this league: ${writeError.message}`;
  }

  const leagueId = writeResult?.id ?? existing?.id;

  // Mirror into pitboss.leagues (sim leagues only) so FK-dependent tables
  // like pitboss.driver_leagues can resolve this league right away.
  if (leagueId) {
    await mirrorToPitbossLeagues(supabase, leagueId);
  }

  // Save the signup channel AFTER the mirror, so the pitboss.leagues row
  // exists even for a league created by this very run.
  let signupSaveFailed = false;
  if (leagueId && signup.id) {
    const saved = await saveSignupChannel(supabase, leagueId, signup.id);
    signupSaveFailed = !saved;
  }

  const lines: string[] = [
    existing
      ? `**${finalName}** setup updated.`
      : `**${finalName}** is now set up and active.`,
    settingLine("Ticket category", ticket.id ? `<#${ticket.id}>` : null, ticket, "pick it with `fia_category`"),
    settingLine("Reports channel", incident.id ? `<#${incident.id}>` : null, incident, "pick it with `reports_channel`"),
    settingLine("Transcripts", transcript.id ? `<#${transcript.id}>` : null, transcript, "optional, pick with `transcript_channel`"),
    settingLine("Appeals", appeals.id ? `<#${appeals.id}>` : null, appeals, "optional, pick with `appeals_channel`"),
    settingLine("Driver signups", signup.id ? `<#${signup.id}>` : null, signup, "optional, pick with `signup_channel`"),
    settingLine("Steward role", steward.id ? `<@&${steward.id}>` : null, steward, "pick it with `steward_role`"),
  ];

  if (signupSaveFailed) {
    lines.push(
      "⚠️ I couldn't save the driver signup channel. Run `/setup` again, and tell the PitBoss admin if it keeps failing."
    );
  }

  if (!info) {
    lines.push(
      "I couldn't read this server's channels and roles (bot token missing or Discord lookup failed), so only the options you picked were used."
    );
  }

  if (!ticket.id || !incident.id) {
    lines.push(
      "Steward reports won't create tickets until the ticket category and reports channel are set. Run `/setup` again with them picked."
    );
  }

  if (input.financialSystem) {
    lines.push(
      "Financial system requested — salary cap / wallet config isn't set up by this command yet, since it needs specific numbers (cap, apron, starting wallet). Ping the PitBoss admin to configure it."
    );
  } else {
    lines.push("No financial system — matches how AWC/WSC run.");
  }

  return lines.join("\n");
}

registerCommand(
  "setup",
  async (ctx) => {
    if (!ctx.guildId) {
      return { content: "This command must be used in a server, not a DM.", ephemeral: true };
    }

    const hasAdmin = (BigInt(ctx.memberPermissions || "0") & ADMINISTRATOR_BIT) !== 0n;
    if (!hasAdmin) {
      return { content: "Only a server administrator can run `/setup`.", ephemeral: true };
    }

    const guildId = ctx.guildId;

    // Discord resolves CHANNEL / ROLE type options straight to IDs — no
    // separate resolved-lookup needed, since the ID is all rise_os.leagues
    // stores.
    const input: SetupInput = {
      name: (ctx.options.name as string | undefined)?.trim() || undefined,
      fiaCategory: ctx.options.fia_category as string | undefined,
      reportsChannel: ctx.options.reports_channel as string | undefined,
      transcriptChannel: ctx.options.transcript_channel as string | undefined,
      appealsChannel: ctx.options.appeals_channel as string | undefined,
      signupChannel: ctx.options.signup_channel as string | undefined,
      stewardRole: ctx.options.steward_role as string | undefined,
      financialSystem: Boolean(ctx.options.financial_system),
    };

    // Deferred: the Discord channel/role lookups plus two Supabase writes
    // can run past the 3s ACK window, so ACK immediately and PATCH the
    // result in when it's done.
    return {
      defer: true,
      ephemeral: false,
      background: async () => ({ content: await runSetup(guildId, input) }),
    };
  },
  // /setup is the command that creates the league row, so it must be allowed
  // to run on a server that has no row yet.
  { leagueOptional: true }
);
