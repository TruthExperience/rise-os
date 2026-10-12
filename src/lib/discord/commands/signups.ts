import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import {
  openSignupRound,
  sendPendingDms,
  closeSignupRound,
  signupSummary,
  seasonRoundIds,
  sendTestSignup,
} from "@/lib/discord-signups";

// Season signup commands. An owner opens a round for a season; the bot DMs
// every league member with a Discord ID a Sign Up / No Thanks button pair
// (button clicks are handled by handleSignupButton in
// src/lib/discord-signups.ts — see the wiring notes in the hand-off).
//
// Registered in Discord as ONE command, /signups, with six subcommands.
// commands/index.ts builds the dispatch key "<command>_<subcommand>", so the
// handlers below are keyed signups_open / signups_resume / signups_status /
// signups_list / signups_close / signups_test (underscores — NOT hyphens, or
// the router can't find them).
//
//   /signups open    season (optional season number; defaults to the league's
//                    latest "upcoming" season), message (optional custom DM text)
//   /signups resume  continues sending queued DMs after a timeout
//   /signups status  counts for the open round
//   /signups list    names for the open round; show = signed_up (default) |
//                    declined | pending | dm_failed | all
//   /signups close   closes the open round
//   /signups test    user (required), season (optional, defaults to 2).
//                    Sends ONE test invite DM with 3 random F1 25 tracks.
//                    Writes nothing to signup_rounds / league_signups.
//
// Tables: pitboss.signup_rounds (one open round per season),
//         pitboss.league_signups (one row per member per round),
//         rise_os.seasons.
//
// Who gets DM'd: every pitboss.driver_leagues member of the league with a
// Discord ID. Use /members-sync first to bring the Discord server's members
// into driver_leagues.
//
// Owners only: is_owner / is_co_owner / is_commissioner.

const OWNER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;

// VRC #driver-signups (where test responses are posted)
const SIGNUP_CHANNEL_ID = process.env.PITBOSS_SIGNUP_CHANNEL_ID ?? "1559261744470163556";

async function findOpenRound(leagueId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("signup_rounds")
    .select("id, name")
    .eq("league_id", leagueId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message } as const;
  if (!data) return { error: "No signup round is open for this league." } as const;
  return { round: data } as const;
}

registerCommand("signups_open", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can open season signups.", ephemeral: true };
  }

  // Optional season number. Omitted = latest "upcoming" season.
  let seasonId: string | undefined;
  const seasonInput = ctx.options.season as string | number | undefined;
  if (seasonInput !== undefined && seasonInput !== null && seasonInput !== "") {
    const seasonNumber = Number(seasonInput);
    if (!Number.isFinite(seasonNumber)) {
      return { content: "season must be a season number (e.g. 2).", ephemeral: true };
    }

    const supabase = createAdminClient();
    const { data: season, error } = await supabase
      .schema("rise_os")
      .from("seasons")
      .select("id")
      .eq("league_id", leagueId)
      .eq("season_number", seasonNumber)
      .maybeSingle();

    if (error) {
      console.error("[signups_open] season lookup failed:", error);
      return { content: `Something went wrong finding that season: ${error.message}`, ephemeral: true };
    }
    if (!season) {
      return { content: `Season ${seasonNumber} isn't set up for this league.`, ephemeral: true };
    }
    seasonId = season.id;
  }

  const message = ctx.options.message as string | undefined;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const opened = await openSignupRound({
        leagueId,
        openedByDiscordId: ctx.discordUserId,
        seasonId,
        message,
      });
      if (!opened.ok) return { content: opened.error };

      if (opened.invited === 0) {
        return {
          content:
            `Signups are open for **${opened.seasonName}**, but there was nobody to DM ` +
            `(no league members with a Discord ID, or everyone already signed up). ` +
            `If the server has members that aren't in PitBoss yet, run \`/members-sync\` first.`,
        };
      }

      const sent = await sendPendingDms(opened.roundId);

      const lines = [
        `Signups are open for **${opened.seasonName}**.`,
        `Invited ${opened.invited} member(s)` +
          (opened.skippedAlreadySignedUp > 0
            ? ` (${opened.skippedAlreadySignedUp} already signed up, skipped).`
            : "."),
        `DMs: ${sent.sent} sent, ${sent.failed} couldn't be reached (DMs closed).`,
      ];
      if (sent.remaining > 0) {
        lines.push(`${sent.remaining} still queued — run \`/signups resume\` to keep sending.`);
      }
      return { content: lines.join("\n") };
    },
  };
});

registerCommand("signups_resume", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can manage season signups.", ephemeral: true };
  }

  const roundResult = await findOpenRound(leagueId);
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong finding the round.", ephemeral: true };
  }
  const round = roundResult.round;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const sent = await sendPendingDms(round.id);
      const lines = [
        `**${round.name}** — ${sent.sent} sent, ${sent.failed} couldn't be reached.`,
      ];
      if (sent.remaining > 0) {
        lines.push(`${sent.remaining} still queued — run \`/signups resume\` again.`);
      } else {
        lines.push("All DMs have been sent.");
      }
      return { content: lines.join("\n") };
    },
  };
});

registerCommand("signups_status", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can view season signups.", ephemeral: true };
  }

  const roundResult = await findOpenRound(leagueId);
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong finding the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const counts = await signupSummary(round.id);
  const total = counts.invited + counts.signed_up + counts.declined + counts.dm_failed;

  const lines = [
    `**Signups — ${round.name}** (${total} invited)`,
    `✅ Signed up: ${counts.signed_up}`,
    `❌ Declined: ${counts.declined}`,
    `⏳ No answer yet: ${counts.invited}`,
    `📪 Couldn't DM: ${counts.dm_failed}`,
  ];

  return { content: lines.join("\n"), ephemeral: true };
});

// ─── /signups list ───────────────────────────────────────────────────────

type ListFilter = "signed_up" | "declined" | "pending" | "dm_failed" | "all";

const LIST_LABELS: Record<ListFilter, string> = {
  signed_up: "✅ Signed up",
  declined: "❌ Declined",
  pending: "⏳ No answer yet",
  dm_failed: "📪 Couldn't DM",
  all: "Everyone invited",
};

const STATUS_ICON: Record<string, string> = {
  signed_up: "✅",
  declined: "❌",
  invited: "⏳",
  dm_failed: "📪",
};

interface SignupListRow {
  driver_id: string;
  status: string;
  responded_at: string | null;
  drivers:
    | { display_name: string | null; discord_username: string | null; discord_id: string | null }
    | { display_name: string | null; discord_username: string | null; discord_id: string | null }[]
    | null;
}

registerCommand("signups_list", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can view season signups.", ephemeral: true };
  }

  const roundResult = await findOpenRound(leagueId);
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong finding the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const requested = (ctx.options.show as string | undefined) ?? "signed_up";
  const filter: ListFilter = (Object.keys(LIST_LABELS) as ListFilter[]).includes(
    requested as ListFilter
  )
    ? (requested as ListFilter)
    : "signed_up";

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const supabase = createAdminClient();

      // Signed-up lists span every round of the season, so people who signed
      // up in an earlier round still appear after a round is closed/reopened.
      const roundIds =
        filter === "signed_up" ? await seasonRoundIds(round.id) : [round.id];

      let query = supabase
        .schema("pitboss")
        .from("league_signups")
        .select(
          "driver_id, status, responded_at, drivers:driver_id(display_name, discord_username, discord_id)"
        )
        .in("round_id", roundIds);

      if (filter === "pending") query = query.eq("status", "invited");
      else if (filter !== "all") query = query.eq("status", filter);

      const { data, error } = await query.range(0, 4999);
      if (error) {
        console.error("[signups_list] query failed:", error);
        return { content: `Couldn't load the list: ${error.message}` };
      }

      const allRows = ((data ?? []) as unknown as SignupListRow[]).map((r) => {
        const d = Array.isArray(r.drivers) ? r.drivers[0] : r.drivers;
        return {
          driverId: r.driver_id,
          status: r.status,
          respondedAt: r.responded_at,
          name: d?.display_name || d?.discord_username || "Unknown driver",
          discordId: d?.discord_id ?? "",
        };
      });

      // One entry per driver (earliest response wins)
      allRows.sort((a, b) => (a.respondedAt ?? "").localeCompare(b.respondedAt ?? ""));
      const seen = new Set<string>();
      const rows = allRows.filter((r) => {
        if (seen.has(r.driverId)) return false;
        seen.add(r.driverId);
        return true;
      });

      if (rows.length === 0) {
        return { content: `**${round.name}** — nobody in "${LIST_LABELS[filter]}" yet.` };
      }

      // Signed-up list reads best in the order people signed up; the rest A–Z.
      if (filter !== "signed_up") {
        rows.sort((a, b) => a.name.localeCompare(b.name));
      }

      const line = (r: (typeof rows)[number], i: number) =>
        filter === "all"
          ? `${STATUS_ICON[r.status] ?? "•"} ${r.name}`
          : `${i + 1}. ${r.name}`;

      const header = `**${round.name} — ${LIST_LABELS[filter]}** (${rows.length})`;
      const lines = rows.map(line);

      // Discord caps a message at 2000 chars. Show what fits, attach the rest.
      let body = "";
      let shown = 0;
      for (const l of lines) {
        if (header.length + body.length + l.length + 80 > 1900) break;
        body += `\n${l}`;
        shown++;
      }

      if (shown === rows.length) {
        return { content: header + body };
      }

      const fileText =
        `${round.name} — ${LIST_LABELS[filter]} (${rows.length})\n\n` +
        rows
          .map((r, i) => `${i + 1}. ${r.name}${r.discordId ? ` (${r.discordId})` : ""} [${r.status}]`)
          .join("\n");

      return {
        content: `${header}${body}\n…and ${rows.length - shown} more (full list attached).`,
        files: [
          {
            filename: `signups-${filter}.txt`,
            contentType: "text/plain",
            data: Buffer.from(fileText, "utf-8"),
          },
        ],
      };
    },
  };
});

registerCommand("signups_close", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can close season signups.", ephemeral: true };
  }

  const roundResult = await findOpenRound(leagueId);
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong finding the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const counts = await signupSummary(round.id);
  await closeSignupRound(round.id);

  return {
    content:
      `Closed signups for **${round.name}**. ` +
      `${counts.signed_up} signed up, ${counts.declined} declined, ` +
      `${counts.invited} never answered, ${counts.dm_failed} couldn't be DMed.`,
    ephemeral: true,
  };
});

// ─── /signups test ───────────────────────────────────────────────────────
// Sends ONE test invite DM to the chosen user. No rows are written, so an
// existing signup for that person is untouched.

registerCommand("signups_test", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can send test signups.", ephemeral: true };
  }

  const target = ctx.options.user as string | undefined;
  if (!target) {
    return { content: "Pick a user to send the test invite to.", ephemeral: true };
  }

  const seasonInput = ctx.options.season as string | number | undefined;
  const seasonNumber =
    seasonInput !== undefined && seasonInput !== null && seasonInput !== ""
      ? Number(seasonInput)
      : 2;
  if (!Number.isFinite(seasonNumber)) {
    return { content: "season must be a season number (e.g. 2).", ephemeral: true };
  }

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const res = await sendTestSignup({
        leagueId,
        openedByDiscordId: ctx.discordUserId,
        targetDiscordId: target,
        seasonNumber,
      });
      if (!res.ok) return { content: `Test invite failed: ${res.error}` };
      return {
        content:
          `Test invite for Season ${seasonNumber} sent to <@${target}>.\n` +
          `Tracks requested: ${res.tracks.join(", ")}.\n` +
          `Their button response will post in <#${SIGNUP_CHANNEL_ID}>. Nothing is saved.`,
      };
    },
  };
});
