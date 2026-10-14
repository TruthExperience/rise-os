// src/lib/discord/commands/timetrial.ts
//
// /timetrial submit      track, time, screenshot (required), car_class, notes
// /timetrial leaderboard track
//
// Works in a server OR in a DM with the bot:
//   - in a server the league comes from the guild, as usual
//   - in a DM there is no guild, so the league is taken from the driver's
//     league memberships; if they're in more than one, they're asked to run
//     the command in the server instead.
//
// The screenshot is copied into the private "time-trials" storage bucket
// (Discord CDN links expire), same idea as incident evidence.
//
// Wire-up: add `import "./timetrial";` to commands/router.ts next to the
// other side-effect imports.

import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

const BUCKET = "time-trials";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPE = /^(image\/(png|jpe?g|webp|gif)|video\/(mp4|quicktime|webm))$/i;

// Only fetch attachments from Discord's own CDN.
const ALLOWED_FETCH_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

// Discord normally sends a content type with each attachment, but it's
// optional in our resolved shape — fall back to the file extension so a
// missing one doesn't reject a perfectly good screenshot.
function guessContentType(filename: string | undefined): string | undefined {
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
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    default:
      return undefined;
  }
}

// "1:23.456" -> 83456, "83.456" -> 83456, "1:23" -> 83000.
function parseLapTime(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^(?:(\d{1,2}):)?(\d{1,3})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const minutes = m[1] ? parseInt(m[1], 10) : 0;
  const seconds = parseInt(m[2], 10);
  if (m[1] && seconds >= 60) return null;
  const millis = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
  const total = (minutes * 60 + seconds) * 1000 + millis;
  return total >= 20_000 && total <= 600_000 ? total : null;
}

function formatLapTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const sec = String(seconds).padStart(2, "0");
  const mil = String(millis).padStart(3, "0");
  return minutes > 0 ? `${minutes}:${sec}.${mil}` : `${seconds}.${mil}`;
}

function trackKey(track: string): string {
  return track.trim().toLowerCase().replace(/\s+/g, " ");
}

async function getOrCreateDriverId(discordId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .schema("pitboss")
    .from("drivers")
    .insert({ discord_id: discordId, discord_username: discordId })
    .select("id")
    .single();
  if (error || !created) {
    console.error("[timetrial] driver creation failed:", error);
    return null;
  }
  return created.id;
}

// In a server ctx.leagueId is set. In a DM, fall back to the driver's single
// league membership.
async function resolveLeagueId(
  ctxLeagueId: string | undefined,
  driverId: string
): Promise<{ leagueId: string } | { error: string }> {
  if (ctxLeagueId) return { leagueId: ctxLeagueId };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("league_id")
    .eq("driver_id", driverId);

  if (error) {
    console.error("[timetrial] league lookup failed:", error);
    return { error: "Couldn't work out which league this is for — try again in a moment." };
  }
  const ids = Array.from(new Set((data ?? []).map((r) => r.league_id as string)));
  if (ids.length === 1) return { leagueId: ids[0] };
  if (ids.length === 0) {
    return { error: "You're not in any league yet, so I can't file a time trial for you." };
  }
  return {
    error:
      "You're in more than one league, so run `/timetrial submit` in the league's server instead of a DM.",
  };
}

async function copyToStorage(params: {
  leagueId: string;
  driverId: string;
  url: string;
  filename?: string;
  contentType?: string;
}): Promise<{ path: string; contentType: string } | { error: string }> {
  const contentType =
    params.contentType ?? guessContentType(params.filename) ?? "application/octet-stream";
  if (!ALLOWED_TYPE.test(contentType)) {
    return { error: "Attach a screenshot (png/jpg/webp) or a video clip (mp4/mov/webm)." };
  }

  let host: string;
  try {
    host = new URL(params.url).hostname;
  } catch {
    return { error: "Couldn't read your attachment." };
  }
  if (!ALLOWED_FETCH_HOSTS.has(host)) {
    return { error: "Attachments can only be copied from Discord." };
  }

  let res: Response;
  try {
    res = await fetch(params.url);
  } catch (err) {
    console.error("[timetrial] attachment download threw:", err);
    return { error: "Couldn't download your attachment from Discord." };
  }
  if (!res.ok) return { error: "Couldn't download your attachment from Discord." };

  // Reject oversized files before pulling them into memory when Discord
  // tells us the size up front.
  const declaredLength = Number(res.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_FILE_BYTES) {
    return { error: "That file is over 25 MB — attach a smaller clip or a screenshot." };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { error: "That file is over 25 MB — attach a smaller clip or a screenshot." };
  }

  const safeName = (params.filename ?? "evidence").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${params.leagueId}/${params.driverId}/${Date.now()}-${safeName}`;

  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) {
    console.error("[timetrial] storage upload failed:", error);
    return { error: "Couldn't save your attachment — try again in a moment." };
  }
  return { path, contentType };
}

registerCommand(
  "timetrial_submit",
  async (ctx) => {
    const track = (ctx.options.track as string | undefined)?.trim();
    const timeRaw = ctx.options.time as string | undefined;
    const carClass = (ctx.options.car_class as string | undefined)?.trim();
    const notes = (ctx.options.notes as string | undefined)?.trim();
    const attachmentId = ctx.options.screenshot as string | undefined;
    const attachment = attachmentId ? ctx.resolvedAttachments[attachmentId] : undefined;

    if (!track) return { content: "`track` is required.", ephemeral: true };
    if (!timeRaw) return { content: "`time` is required.", ephemeral: true };

    const lapMs = parseLapTime(timeRaw);
    if (lapMs === null) {
      return {
        content:
          "I couldn't read that lap time. Use `1:23.456` (minutes:seconds.thousandths) or `83.456`. It must be between 20 seconds and 10 minutes.",
        ephemeral: true,
      };
    }
    if (!attachment?.url) {
      return {
        content: "Attach a screenshot or clip of the lap in `screenshot` — it's required.",
        ephemeral: true,
      };
    }

    // Always deferred: downloading and re-uploading the file can outlast
    // Discord's 3-second ACK window.
    return {
      defer: true,
      ephemeral: true,
      background: async () => {
        const driverId = await getOrCreateDriverId(ctx.discordUserId);
        if (!driverId) {
          return { content: "Couldn't set up your driver record — try again in a moment." };
        }

        const league = await resolveLeagueId(ctx.leagueId, driverId);
        if ("error" in league) return { content: league.error };

        const supabase = createAdminClient();
        const key = trackKey(track);

        // Personal best check BEFORE inserting.
        const { data: prior } = await supabase
          .schema("pitboss")
          .from("time_trials")
          .select("lap_time_ms")
          .eq("league_id", league.leagueId)
          .eq("driver_id", driverId)
          .eq("track_key", key)
          .order("lap_time_ms", { ascending: true })
          .limit(1)
          .maybeSingle();

        const copied = await copyToStorage({
          leagueId: league.leagueId,
          driverId,
          url: attachment.url,
          filename: attachment.filename,
          contentType: attachment.contentType,
        });
        if ("error" in copied) {
          return { content: `${copied.error} Nothing was saved.` };
        }

        const { error } = await supabase
          .schema("pitboss")
          .from("time_trials")
          .insert({
            league_id: league.leagueId,
            driver_id: driverId,
            track,
            track_key: key,
            car_class: carClass ?? null,
            lap_time_ms: lapMs,
            evidence_path: copied.path,
            evidence_type: copied.contentType,
            notes: notes ?? null,
            submitted_via: ctx.guildId ? "discord" : "discord_dm",
          });

        if (error) {
          console.error("[timetrial_submit] insert failed:", error);
          return { content: `Couldn't save your time trial: ${error.message}` };
        }

        const pb =
          !prior
            ? "First lap on this track — nice."
            : lapMs < prior.lap_time_ms
              ? `New personal best! (previous ${formatLapTime(prior.lap_time_ms)})`
              : `Your best here is still ${formatLapTime(prior.lap_time_ms)}.`;

        return {
          content: `Logged **${formatLapTime(lapMs)}** at **${track}**${
            carClass ? ` (${carClass})` : ""
          }. ${pb}\nIt shows as unverified until a steward checks your evidence.`,
        };
      },
    };
  },
  { leagueOptional: true }
);

registerCommand("timetrial_leaderboard", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "Run this in a league server.", ephemeral: true };
  }
  const track = (ctx.options.track as string | undefined)?.trim();
  if (!track) return { content: "`track` is required.", ephemeral: true };

  const supabase = createAdminClient();
  // time_trials has TWO foreign keys to pitboss.drivers (driver_id and
  // verified_by), so a bare `drivers(...)` embed is ambiguous and PostgREST
  // rejects it. Name the driver_id relationship explicitly.
  const { data, error } = await supabase
    .schema("pitboss")
    .from("time_trials")
    .select(
      "lap_time_ms, car_class, verified, drivers!time_trials_driver_id_fkey(discord_id)"
    )
    .eq("league_id", leagueId)
    .eq("track_key", trackKey(track))
    .order("lap_time_ms", { ascending: true })
    .limit(200);

  if (error) {
    console.error("[timetrial_leaderboard] query failed:", error);
    return { content: `Couldn't load the leaderboard: ${error.message}`, ephemeral: true };
  }
  if (!data || data.length === 0) {
    return { content: `No time trials logged for **${track}** yet.`, ephemeral: true };
  }

  // Best lap per driver.
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const row of data as any[]) {
    const discordId: string | undefined = row.drivers?.discord_id;
    if (!discordId || seen.has(discordId)) continue;
    seen.add(discordId);
    rows.push(
      `${rows.length + 1}. <@${discordId}> — **${formatLapTime(row.lap_time_ms)}**${
        row.car_class ? ` (${row.car_class})` : ""
      }${row.verified ? " ✅" : ""}`
    );
    if (rows.length === 10) break;
  }

  return {
    content: `**Time trial — ${track}**\n${rows.join("\n")}\n_✅ = verified by a steward_`,
    ephemeral: false,
  };
});
