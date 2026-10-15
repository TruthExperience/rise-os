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
  sendIndividualInvite,
  signupChannelId,
  parseTracks,
  leagueTeamOptions,
  requestedTracksFromMessage,
  setRoundTracks,
  notifySignedUpForPhotos,
} from "@/lib/discord-signups";

// Season signup commands. An owner opens a round for a season; the bot DMs
// every league member with a Discord ID a Sign Up / No Thanks button pair
// (button clicks are handled by handleSignupButton in
// src/lib/discord-signups.ts — see the wiring notes in the hand-off).
//
// Registered in Discord as ONE command, /signups, with eight subcommands.
// commands/index.ts builds the dispatch key "<command>_<subcommand>", so the
// handlers below are keyed signups_open / signups_resume / signups_status /
// signups_list / signups_close / signups_invite / signups_tracks /
// signups_test (underscores — NOT hyphens, or the router can't find them).
//
//   /signups open    season (optional season number; defaults to the league's
//                    latest "upcoming" season), message (optional custom DM
//                    text), tracks (optional, up to 3 tracks to request
//                    pictures of, separated by commas). Leave tracks off for
//                    seasons that don't need time trial pictures (e.g. VRC
//                    season 2); set it for seasons that do (season 3).
//   /signups resume  continues sending queued DMs after a timeout
//   /signups status  counts for the open round
//   /signups list    names for the open round; show = signed_up (default) |
//                    declined | pending | dm_failed | all
//   /signups close   closes the open round
//   /signups invite  user (required). Sends the open round's real signup
//                    invite to ONE racer. Their answer is saved like any other
//                    signup. Needs an open round.
//   /signups tracks  tracks (required, up to 3, commas), notify (optional
//                    boolean). Adds or replaces the picture request on the
//                    OPEN round without re-inviting anyone. Anyone who taps
//                    Sign Up afterwards is asked for the pictures; notify=true
//                    also DMs drivers who already signed up. Use this when a
//                    round was opened without tracks.
//   /signups test    user (required), season (optional, defaults to 2),
//                    tracks (optional: up to 3 tracks, or "random" for 3
//                    random F1 25 tracks; omit for no pictures request).
//                    Sends ONE test invite DM. Works in any league.
//                    Writes nothing to signup_rounds / league_signups.
//
// Team requests: after a driver taps Sign Up, the bot offers team buttons
// (1st / 2nd / 3rd choice) when the league has team_rosters on file, then DMs
// each requested team's principal(s). That flow lives in discord-signups.ts
// (handleSignupButton); /signups open just reports whether it is on.
//
// Driver-facing, registered as its own command so it can be used from a DM:
//
//   /signup photos   screenshot_1 (required), screenshot_2, screenshot_3,
//                    league (optional). Works in a DM with the bot or in a
//                    league server. The bot re-posts the images into the
//                    league's signup channel (pitboss.leagues.signup_channel_id).
//                    In a DM, a driver signed up in MORE than one league
//                    types `league` (name, slug or initials, e.g. "wsc") to
//                    say which one; it is ignored in a league server, where
//                    the league is already known. Key: signup_photos
//                    (leagueOptional).
//
// Signup channel: each league has its own, stored in
// pitboss.leagues.signup_channel_id. Test responses and screenshots are posted
// there. A league with no channel set posts nothing to a channel (screenshots
// are still saved). Set one with /setup (signup_channel option, or
// auto-detected from a channel named like "driver-signups"), or:
//   update pitboss.leagues set signup_channel_id = '<channel id>' where slug = '<slug>';
//
// Tables: pitboss.signup_rounds (one open round per season),
//         pitboss.league_signups (one row per member per round),
//         pitboss.signup_team_choices (team requests, one row per pick),
//         pitboss.signup_photos (screenshot log; files live in the
//         "time-trials" storage bucket),
//         rise_os.seasons.
//
// Who gets DM'd: every pitboss.driver_leagues member of the league with a
// Discord ID. Use /members-sync first to bring the Discord server's members
// into driver_leagues.
//
// Owners only (the /signups commands): is_owner / is_co_owner / is_commissioner.

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

  // Optional tracks to request pictures of (max 3, comma separated).
  const tracksInput = ctx.options.tracks as string | undefined;
  const tracks = parseTracks(tracksInput);
  const trackCount = (tracksInput ?? "").split(/[;,\n]/).filter((t) => t.trim()).length;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const opened = await openSignupRound({
        leagueId,
        openedByDiscordId: ctx.discordUserId,
        seasonId,
        message,
        tracks,
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
      const teams = await leagueTeamOptions(leagueId);

      const lines = [
        `Signups are open for **${opened.seasonName}**.`,
        `Invited ${opened.invited} member(s)` +
          (opened.skippedAlreadySignedUp > 0
            ? ` (${opened.skippedAlreadySignedUp} already signed up, skipped).`
            : "."),
        `DMs: ${sent.sent} sent, ${sent.failed} couldn't be reached (DMs closed).`,
        tracks.length > 0
          ? `Pictures requested: ${tracks.join(", ")}` +
            (trackCount > tracks.length ? ` (only the first ${tracks.length} are used).` : ".")
          : "No track pictures requested. Add them later with `/signups tracks`.",
        teams.length > 0
          ? `Team requests: on (${teams.length} teams). Principals are DM'd when a driver finishes picking.`
          : "Team requests: off (no team rosters on file for this league).",
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

// ─── /signups invite ─────────────────────────────────────────────────────
// Invites ONE racer to the league's open round. Real invite: the answer is
// saved to league_signups like any other signup. Uses the round's own invite
// text, so track pictures are requested only if the round asked for them.

registerCommand("signups_invite", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can send signup invites.", ephemeral: true };
  }

  const target = ctx.options.user as string | undefined;
  if (!target) {
    return { content: "Pick a racer to invite.", ephemeral: true };
  }

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const res = await sendIndividualInvite({
        leagueId,
        invitedByDiscordId: ctx.discordUserId,
        targetDiscordId: target,
      });
      if (!res.ok) return { content: `Invite failed: ${res.error}` };

      const lines = [
        `Invited **${res.driverName}** (<@${target}>) to **${res.roundName}**.`,
        res.tracksRequested > 0
          ? `Pictures requested: ${res.tracksRequested} track${res.tracksRequested === 1 ? "" : "s"}.`
          : "No track pictures requested for this round.",
        "Their answer is saved like any other signup. Check `/signups status` or `/signups list`.",
      ];
      return { content: lines.join("\n") };
    },
  };
});

// ─── /signups tracks ─────────────────────────────────────────────────────
// Adds (or replaces) the time trial picture request on the league's open
// round. Nobody is re-invited. See setRoundTracks in discord-signups.ts.

registerCommand("signups_tracks", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return { content: "Only league owners can change signup tracks.", ephemeral: true };
  }

  const tracksInput = ctx.options.tracks as string | undefined;
  const tracks = parseTracks(tracksInput);
  const trackCount = (tracksInput ?? "").split(/[;,\n]/).filter((t) => t.trim()).length;
  if (tracks.length === 0) {
    return {
      content: "Give at least one track, e.g. `Monza, Suzuka, Spa`.",
      ephemeral: true,
    };
  }

  const notify = Boolean(ctx.options.notify);

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const res = await setRoundTracks({
        leagueId,
        byDiscordId: ctx.discordUserId,
        tracks,
      });
      if (!res.ok) return { content: res.error };

      const lines = [
        `${res.replaced ? "Updated" : "Added"} the picture request on **${res.roundName}**: ` +
          res.tracks.join(", ") +
          (trackCount > res.tracks.length
            ? ` (only the first ${res.tracks.length} are used).`
            : "."),
        "Anyone who taps **Sign Up** from now on is asked for them. Invite DMs already delivered keep their old text.",
      ];

      if (notify) {
        const out = await notifySignedUpForPhotos({ roundId: res.roundId, tracks: res.tracks });
        lines.push(
          `Drivers who already signed up: ${out.sent} DM'd, ${out.failed} couldn't be reached, ` +
            `${out.skipped} skipped (already sent pictures or no Discord ID).`
        );
        if (out.remaining > 0) {
          lines.push(
            `${out.remaining} not reached before the time limit. Running it again with notify messages everyone again.`
          );
        }
      } else {
        lines.push("Drivers who already signed up were not messaged. Add `notify: True` to DM them.");
      }

      return { content: lines.join("\n") };
    },
  };
});

// ─── /signups test ───────────────────────────────────────────────────────
// Sends ONE test invite DM to the chosen user. No rows are written, so an
// existing signup for that person is untouched. Works in any league.

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

  // Optional track pictures, same as /signups open: a list of up to 3 tracks,
  // or "random" for 3 random F1 25 tracks. Omitted = no pictures requested.
  const tracksInput = (ctx.options.tracks as string | undefined)?.trim();
  const randomTracks = tracksInput?.toLowerCase() === "random";
  const tracks = randomTracks ? [] : parseTracks(tracksInput);

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const res = await sendTestSignup({
        leagueId,
        openedByDiscordId: ctx.discordUserId,
        targetDiscordId: target,
        seasonNumber,
        tracks,
        randomTracks,
      });
      if (!res.ok) return { content: `Test invite failed: ${res.error}` };

      const channelId = await signupChannelId(leagueId);
      const lines = [
        `Test invite for Season ${seasonNumber} sent to <@${target}>.`,
        res.tracks.length > 0
          ? `Pictures requested: ${res.tracks.join(", ")}.`
          : "No track pictures requested.",
        channelId
          ? `Their button response will post in <#${channelId}>. Nothing is saved.`
          : "This league has no signup channel set, so their response won't be posted anywhere. Nothing is saved.",
      ];
      return { content: lines.join("\n") };
    },
  };
});

// ─── /signup photos ──────────────────────────────────────────────────────
// Driver-facing (NOT owner-only). The signup invite asks for screenshots, but
// the signup channel is private, so drivers can't post there themselves. This
// lets them send the images to the bot instead — from the invite DM or from
// the league server — and the bot re-posts them into the league's signup
// channel.
//
// The bot only receives slash commands and button clicks, not ordinary DM
// messages, so this has to be a command (same approach as /steward respond
// and /timetrial submit). Registered leagueOptional so it runs from a DM,
// where there is no guild to resolve a league from.
//
// A driver can use it once they have tapped Sign Up for an open round.
// Each image is saved to the private "time-trials" storage bucket under
// signups/<league>/<round>/<driver>/ and logged in pitboss.signup_photos
// (slot N = the Nth requested track), then re-posted to the signup channel.
//
// In a DM there is no guild to say which league this is for. If the driver is
// signed up in only one, that's the one. If they're signed up in several, they
// pick with the optional `league` option (see pickSignupByLeague below).

const PHOTO_BUCKET = "time-trials";
const PHOTO_SLOTS = ["screenshot_1", "screenshot_2", "screenshot_3"] as const;
const PHOTO_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per image, 24 MB for all three
const PHOTO_TYPE = /^image\/(png|jpe?g|webp|gif)$/i;

// Only fetch attachments from Discord's own CDN.
const PHOTO_FETCH_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

// Discord normally sends a content type with each attachment; fall back to the
// file extension so a missing one doesn't reject a perfectly good screenshot.
function guessPhotoType(filename: string | undefined): string | undefined {
  const ext = filename?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

interface DownloadedPhoto {
  filename: string;
  contentType: string;
  data: ArrayBuffer;
}

async function downloadPhoto(
  att: { url: string; filename?: string; contentType?: string },
  position: number
): Promise<DownloadedPhoto | { error: string }> {
  const contentType = (att.contentType ?? guessPhotoType(att.filename) ?? "")
    .split(";")[0]
    .trim();
  if (!PHOTO_TYPE.test(contentType)) {
    return { error: `Screenshot ${position} isn't an image — attach a png, jpg or webp.` };
  }

  let host: string;
  try {
    host = new URL(att.url).hostname;
  } catch {
    return { error: `Couldn't read screenshot ${position}.` };
  }
  if (!PHOTO_FETCH_HOSTS.has(host)) {
    return { error: "Attachments can only be copied from Discord." };
  }

  let res: Response;
  try {
    res = await fetch(att.url);
  } catch (err) {
    console.error("[signup_photos] download threw:", err);
    return { error: `Couldn't download screenshot ${position} from Discord.` };
  }
  if (!res.ok) return { error: `Couldn't download screenshot ${position} from Discord.` };

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > PHOTO_MAX_BYTES) {
    return { error: `Screenshot ${position} is over 8 MB — attach a smaller image.` };
  }

  const data = await res.arrayBuffer();
  if (data.byteLength > PHOTO_MAX_BYTES) {
    return { error: `Screenshot ${position} is over 8 MB — attach a smaller image.` };
  }

  const safeName = (att.filename ?? `screenshot-${position}`).replace(/[^a-zA-Z0-9._-]/g, "_");
  return { filename: `${position}-${safeName}`, contentType, data };
}

// Posts one message with up to three image files. multipart/form-data: a
// payload_json part carries the content and files[N] parts carry the bytes. Do
// NOT set a Content-Type header manually — fetch adds the multipart boundary.
async function postSignupPhotos(
  channelId: string,
  content: string,
  photos: DownloadedPhoto[]
): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[signup_photos] PITBOSS_DISCORD_BOT_TOKEN not set");
    return false;
  }

  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content, allowed_mentions: { parse: [] } })
  );
  photos.forEach((p, i) => {
    form.append(`files[${i}]`, new Blob([p.data], { type: p.contentType }), p.filename);
  });

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });

  if (!res.ok) {
    console.error("[signup_photos] channel post failed:", res.status, await res.text());
    return false;
  }
  return true;
}

// ─── League choice for /signup photos in a DM ────────────────────────────

interface SignedUpRound {
  id: string;
  name: string;
  league_id: string;
  message: string | null;
}

interface SignupChoice extends SignedUpRound {
  league_name: string;
  slug: string;
}

// "World Series Championship" -> "wsc"
function leagueInitials(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toLowerCase())
    .join("");
}

// Lower-case and drop everything that isn't a letter or digit, so "WSC",
// "wsc", "Vector Racing" and "vector-racing" all compare on equal footing.
function leagueKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function choiceLabel(c: SignupChoice): string {
  return `${c.league_name} (${c.name})`;
}

// Adds each round's league name and slug so a typed `league` can be matched.
async function describeSignupChoices(
  supabase: ReturnType<typeof createAdminClient>,
  rounds: SignedUpRound[]
): Promise<SignupChoice[]> {
  const ids = Array.from(new Set(rounds.map((r) => r.league_id)));
  const { data, error } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug")
    .in("id", ids);
  if (error) {
    console.error("[signup_photos] league name lookup failed:", error);
  }

  const byId = new Map<string, { name: string | null; slug: string | null }>(
    (data ?? []).map((l: any) => [l.id as string, { name: l.name, slug: l.slug }])
  );

  return rounds.map((r) => {
    const l = byId.get(r.league_id);
    return { ...r, league_name: l?.name ?? r.name, slug: l?.slug ?? "" };
  });
}

// Matches what the driver typed against the leagues they're signed up in.
// Accepts the league name, its slug, its initials (e.g. "wsc" for World
// Series Championship) or the round name, in any case. An exact match wins;
// otherwise a partial match counts if it points at exactly one signup.
function pickSignupByLeague(
  input: string,
  choices: SignupChoice[]
): { choice: SignupChoice } | { error: "none" | "ambiguous"; matches: SignupChoice[] } {
  const key = leagueKey(input);
  if (key.length < 2) return { error: "none", matches: [] };

  const candidates = (c: SignupChoice) =>
    [c.league_name, c.slug, leagueInitials(c.league_name), c.name]
      .map(leagueKey)
      .filter(Boolean);

  const exact = choices.filter((c) => candidates(c).includes(key));
  if (exact.length === 1) return { choice: exact[0] };
  if (exact.length > 1) return { error: "ambiguous", matches: exact };

  const partial = choices.filter((c) => candidates(c).some((k) => k.includes(key)));
  if (partial.length === 1) return { choice: partial[0] };
  return { error: partial.length > 1 ? "ambiguous" : "none", matches: partial };
}

registerCommand(
  "signup_photos",
  async (ctx) => {
    const attachments: { url: string; filename?: string; contentType?: string }[] = [];
    for (const slot of PHOTO_SLOTS) {
      const id = ctx.options[slot] as string | undefined;
      const attachment = id ? ctx.resolvedAttachments[id] : undefined;
      if (attachment?.url) attachments.push(attachment);
    }

    if (attachments.length === 0) {
      return {
        content: "Attach at least one screenshot in `screenshot_1` (up to three in total).",
        ephemeral: true,
      };
    }

    // Optional. Only used in a DM, to say which league when the driver is
    // signed up in more than one. In a league server the league is known.
    const leagueInput = ((ctx.options.league as string | undefined) ?? "").trim();

    // Always deferred: downloading and re-uploading images can outlast
    // Discord's 3-second ACK window.
    return {
      defer: true,
      ephemeral: true,
      background: async () => {
        const supabase = createAdminClient();

        const { data: driver } = await supabase
          .schema("pitboss")
          .from("drivers")
          .select("id, display_name, discord_username")
          .eq("discord_id", ctx.discordUserId)
          .maybeSingle();
        if (!driver) {
          return {
            content:
              "I can't find a driver record for you, so I can't match these to a signup. " +
              "Ask a league owner to run `/members-sync`.",
          };
        }

        // Which league(s)? In a server it's that league; in a DM, every league
        // the driver belongs to.
        let leagueIds: string[];
        if (ctx.leagueId) {
          leagueIds = [ctx.leagueId];
        } else {
          const { data: memberships, error: membershipError } = await supabase
            .schema("pitboss")
            .from("driver_leagues")
            .select("league_id")
            .eq("driver_id", driver.id);
          if (membershipError) {
            console.error("[signup_photos] membership lookup failed:", membershipError);
            return { content: "Couldn't work out which league this is for — try again in a moment." };
          }
          leagueIds = Array.from(
            new Set((memberships ?? []).map((m) => m.league_id as string))
          );
        }
        if (leagueIds.length === 0) {
          return { content: "You're not in any league yet, so there's no signup to attach these to." };
        }

        const { data: openRounds, error: roundsError } = await supabase
          .schema("pitboss")
          .from("signup_rounds")
          .select("id, name, league_id, message")
          .in("league_id", leagueIds)
          .eq("status", "open");
        if (roundsError) {
          console.error("[signup_photos] round lookup failed:", roundsError);
          return { content: "Couldn't look up the open signup — try again in a moment." };
        }
        if (!openRounds || openRounds.length === 0) {
          return { content: "There's no signup open right now." };
        }

        // Only drivers who have tapped Sign Up. Checked across every round of
        // the season, so someone who signed up in an earlier round still counts.
        const signedUpRounds: SignedUpRound[] = [];
        for (const openRound of openRounds) {
          const roundIds = await seasonRoundIds(openRound.id);
          const { data: rows } = await supabase
            .schema("pitboss")
            .from("league_signups")
            .select("driver_id")
            .eq("driver_id", driver.id)
            .eq("status", "signed_up")
            .in("round_id", roundIds)
            .limit(1);
          if (rows && rows.length > 0) {
            signedUpRounds.push({
              id: openRound.id,
              name: openRound.name,
              league_id: openRound.league_id,
              message: (openRound as any).message ?? null,
            });
          }
        }

        if (signedUpRounds.length === 0) {
          return {
            content:
              "I don't see a signup from you yet. Tap **Sign Up** on your invite first, " +
              "then send the screenshots again.",
          };
        }

        // Settle which signup these screenshots belong to.
        let round: SignedUpRound;
        if (leagueInput && !ctx.leagueId) {
          // In a DM with a league typed: match it against the leagues they
          // actually signed up in.
          const choices = await describeSignupChoices(supabase, signedUpRounds);
          const picked = pickSignupByLeague(leagueInput, choices);
          if ("error" in picked) {
            const list = (picked.matches.length > 0 ? picked.matches : choices)
              .map(choiceLabel)
              .join(", ");
            return {
              content:
                picked.error === "ambiguous"
                  ? `"${leagueInput}" matches more than one of your signups: ${list}. ` +
                    "Type more of the league's name."
                  : `I don't see a signup from you in a league matching "${leagueInput}". ` +
                    `You're signed up in: ${list}.`,
            };
          }
          round = picked.choice;
        } else if (signedUpRounds.length > 1) {
          const choices = await describeSignupChoices(supabase, signedUpRounds);
          const example = choices.find((c) => c.slug)?.slug ?? "wsc";
          return {
            content:
              `You're signed up in more than one league: ${choices.map(choiceLabel).join(", ")}. ` +
              `Run \`/signup photos\` again and fill in the \`league\` option ` +
              `(for example \`league: ${example}\`), or run it in that league's server. ` +
              "Nothing was posted.",
          };
        } else {
          round = signedUpRounds[0];
        }

        const photos: DownloadedPhoto[] = [];
        for (let i = 0; i < attachments.length; i++) {
          const result = await downloadPhoto(attachments[i], i + 1);
          if ("error" in result) return { content: `${result.error} Nothing was posted.` };
          photos.push(result);
        }

        // Slot N is matched to the Nth track the round asked for (if any).
        const tracks = requestedTracksFromMessage(round.message);

        // 1. Save every image to storage first, so the record exists even if
        //    the channel post fails.
        const stamp = Date.now();
        const basePath = `signups/${round.league_id}/${round.id}/${driver.id}`;
        const uploaded: { path: string; photo: DownloadedPhoto; slot: number }[] = [];

        for (let i = 0; i < photos.length; i++) {
          const photo = photos[i];
          const path = `${basePath}/${stamp}-${photo.filename}`;
          const { error: uploadError } = await supabase.storage
            .from(PHOTO_BUCKET)
            .upload(path, photo.data, { contentType: photo.contentType, upsert: false });

          if (uploadError) {
            console.error("[signup_photos] storage upload failed:", uploadError);
            if (uploaded.length > 0) {
              await supabase.storage
                .from(PHOTO_BUCKET)
                .remove(uploaded.map((u) => u.path));
            }
            return {
              content:
                "I couldn't save your screenshots, so nothing was sent. " +
                "Try again in a moment, and tell a league owner if it keeps happening.",
            };
          }
          uploaded.push({ path, photo, slot: i + 1 });
        }

        // 2. Log them against the signup.
        const { error: logError } = await supabase
          .schema("pitboss")
          .from("signup_photos")
          .insert(
            uploaded.map((u) => ({
              round_id: round.id,
              league_id: round.league_id,
              driver_id: driver.id,
              slot: u.slot,
              track: tracks[u.slot - 1] ?? null,
              storage_bucket: PHOTO_BUCKET,
              storage_path: u.path,
              filename: u.photo.filename,
              content_type: u.photo.contentType,
              size_bytes: u.photo.data.byteLength,
            }))
          );
        if (logError) {
          console.error("[signup_photos] log insert failed:", logError);
          await supabase.storage.from(PHOTO_BUCKET).remove(uploaded.map((u) => u.path));
          return {
            content:
              "I couldn't record your screenshots, so nothing was sent. " +
              "Try again in a moment, and tell a league owner if it keeps happening.",
          };
        }

        // 3. Re-post to the league's signup channel.
        const name = driver.display_name || driver.discord_username || "A driver";
        const trackLines = tracks.length
          ? "\n" +
            photos
              .map((_, i) => (tracks[i] ? `${i + 1}. ${tracks[i]}` : null))
              .filter(Boolean)
              .join("\n")
          : "";
        const content =
          `📸 **${name}** (<@${ctx.discordUserId}>) sent ${photos.length} ` +
          `signup screenshot${photos.length === 1 ? "" : "s"} for **${round.name}**.` +
          trackLines;

        const channelId = await signupChannelId(round.league_id);
        const posted = channelId
          ? await postSignupPhotos(channelId, content, photos)
          : false;
        if (!posted) {
          return {
            content:
              "Your screenshots are saved, but I couldn't post them to the signup channel. " +
              "Tell a league owner.",
          };
        }

        return {
          content:
            `Saved and sent ${photos.length} screenshot${photos.length === 1 ? "" : "s"} ` +
            `for **${round.name}**. You're all set.`,
        };
      },
    };
  },
  { leagueOptional: true }
);
