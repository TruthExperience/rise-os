import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import {
  openSignupRound,
  sendPendingDms,
  closeSignupRound,
  signupSummary,
} from "@/lib/discord-signups";

// Season signup commands. An owner opens a round for a season; the bot DMs
// every league member with a Discord ID a Sign Up / No Thanks button pair
// (button clicks are handled by handleSignupButton in
// src/lib/discord-signups.ts — see the wiring notes in the hand-off).
//
//   signups-open    season (optional season number; defaults to the league's
//                   latest "upcoming" season), message (optional custom DM text)
//   signups-resume  continues sending queued DMs after a timeout
//   signups-status  counts for the open round
//   signups-close   closes the open round
//
// Tables: pitboss.signup_rounds (one open round per season),
//         pitboss.league_signups (one row per member per round),
//         rise_os.seasons.
//
// Owners only: is_owner / is_co_owner / is_commissioner.

const OWNER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;

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

registerCommand("signups-open", async (ctx) => {
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
      console.error("[signups-open] season lookup failed:", error);
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
            `(no members with a Discord ID, or everyone already signed up).`,
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
        lines.push(`${sent.remaining} still queued — run \`/signups-resume\` to keep sending.`);
      }
      return { content: lines.join("\n") };
    },
  };
});

registerCommand("signups-resume", async (ctx) => {
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
        lines.push(`${sent.remaining} still queued — run \`/signups-resume\` again.`);
      } else {
        lines.push("All DMs have been sent.");
      }
      return { content: lines.join("\n") };
    },
  };
});

registerCommand("signups-status", async (ctx) => {
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

registerCommand("signups-close", async (ctx) => {
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
