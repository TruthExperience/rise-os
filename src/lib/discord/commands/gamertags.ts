import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// /gamertags import [channel] [apply]
//
// Reads a gamertags channel (e.g. #t1-gamertags) and saves what each person
// posted into pitboss.driver_gamertags. The Discord account that wrote the
// message decides WHOSE gamertag it is, so there's no guessing from nicknames.
//
// Platform is read from the message: "xbox"/"ps"/"ps5"/"psn" -> that platform;
// "ea"/"pc" -> pc (EA IDs are stored as pc); a line with no platform word is
// treated as an EA ID (pc). Formats handled: "Ea - Clyde564", "ea:ledbott",
// "Xbox K9A9", "shannonpro - ea", and several platforms in one message.
//
// Without apply:true it only previews. Needs Read Message History on the
// channel, and the bot's Message Content intent turned on in the Discord
// developer portal, or message text comes back empty.

const ALLOWED_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner", // head admin
  "is_head_steward", // head FIA
  "is_steward", // FIA
] as const;

type Platform = "pc" | "ps5" | "xbox";
const DISCORD_API = "https://discord.com/api/v10";
const MAX_MESSAGES = 500;

const KEYWORD = /\b(xbox|psn|ps5|ps4|ps|playstation|ea|pc|steam)\b/gi;

function platformOf(word: string): Platform {
  const w = word.toLowerCase();
  if (w === "xbox") return "xbox";
  if (w === "ea" || w === "pc" || w === "steam") return "pc";
  return "ps5";
}

function cleanTag(raw: string): string {
  return raw
    .replace(/\(edited\)/gi, "")
    .replace(/^[\s:\-–—=|,]+/, "")
    .replace(/[\s:\-–—=|,]+$/, "")
    .replace(/[*_`~]{2,}/g, "")
    .replace(/\s+(or|and|&)$/i, "")
    .trim();
}

// One message -> list of { platform, tag }.
export function parseGamertagMessage(content: string): { platform: Platform; tag: string }[] {
  const out: { platform: Platform; tag: string }[] = [];
  for (const line of content.split(/\n+/)) {
    const text = line.trim();
    if (!text) continue;

    const parts = text.split(KEYWORD); // [pre, kw, seg, kw, seg, ...]
    if (parts.length === 1) {
      const tag = cleanTag(text);
      if (tag) out.push({ platform: "pc", tag });
      continue;
    }

    const pre = cleanTag(parts[0]);
    for (let i = 1; i < parts.length; i += 2) {
      const platform = platformOf(parts[i]);
      let tag = cleanTag(parts[i + 1] ?? "");
      // "shannonpro - ea": the platform word comes after the tag.
      if (!tag && i === 1 && pre) tag = pre;
      // "... or ps is the same" style notes aren't a gamertag.
      if (/^(is|are)\b.*\bsame\b/i.test(tag) || /^the same$/i.test(tag)) continue;
      if (tag) out.push({ platform, tag });
    }
  }
  return out;
}

async function fetchChannelMessages(channelId: string) {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) return { error: "PITBOSS_DISCORD_BOT_TOKEN not set" } as const;

  const messages: { id: string; content: string; author: { id: string; bot?: boolean } }[] = [];
  let before: string | undefined;
  while (messages.length < MAX_MESSAGES) {
    const url = `${DISCORD_API}/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) {
      return {
        error: `Couldn't read that channel (${res.status}). Give the bot View Channel and Read Message History there.`,
      } as const;
    }
    const batch = (await res.json()) as typeof messages;
    if (batch.length === 0) break;
    messages.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return { messages } as const;
}

registerCommand("gamertags_import", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...ALLOWED_FLAGS])) {
    return {
      content: "Only owners, co-owners, commissioners and stewards (FIA / head FIA) can import gamertags.",
      ephemeral: true,
    };
  }

  const channelId = (ctx.options.channel as string | undefined) ?? ctx.channelId;
  if (!channelId) {
    return { content: "Pick a channel with the `channel` option.", ephemeral: true };
  }
  const apply = ctx.options.apply === true;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const fetched = await fetchChannelMessages(channelId);
      if ("error" in fetched) return { content: fetched.error };

      // Oldest first so a person's later message wins.
      const messages = fetched.messages
        .filter((m) => !m.author.bot)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

      if (messages.length > 0 && messages.every((m) => !m.content)) {
        return {
          content:
            "I can see the messages but not their text. Turn on the **Message Content Intent** for the bot in the Discord developer portal, then run this again.",
        };
      }

      // author discord id -> platform -> tag
      const found = new Map<string, Map<Platform, string>>();
      for (const m of messages) {
        const parsed = parseGamertagMessage(m.content ?? "");
        if (parsed.length === 0) continue;
        const slot = found.get(m.author.id) ?? new Map<Platform, string>();
        for (const p of parsed) slot.set(p.platform, p.tag);
        found.set(m.author.id, slot);
      }
      if (found.size === 0) return { content: "No gamertags found in that channel." };

      const supabase = createAdminClient();
      const { data: drivers } = await supabase
        .schema("pitboss")
        .from("drivers")
        .select("id, discord_id, discord_username, display_name")
        .in("discord_id", [...found.keys()]);
      const byDiscord = new Map((drivers ?? []).map((d) => [d.discord_id as string, d]));

      const driverIds = (drivers ?? []).map((d) => d.id);
      const { data: existing } = driverIds.length
        ? await supabase
            .schema("pitboss")
            .from("driver_gamertags")
            .select("driver_id, platform, gamertag")
            .in("driver_id", driverIds)
        : { data: [] as { driver_id: string; platform: string; gamertag: string }[] };
      const existingMap = new Map((existing ?? []).map((e) => [`${e.driver_id}:${e.platform}`, e.gamertag]));

      const rows: { driver_id: string; platform: Platform; gamertag: string }[] = [];
      const lines: string[] = [];
      const noDriver: string[] = [];
      let unchanged = 0;

      for (const [discordId, platforms] of found) {
        const driver = byDiscord.get(discordId);
        if (!driver) {
          noDriver.push(`<@${discordId}>`);
          continue;
        }
        const name = driver.display_name || driver.discord_username || discordId;
        for (const [platform, tag] of platforms) {
          const current = existingMap.get(`${driver.id}:${platform}`);
          if (current === tag) {
            unchanged++;
            continue;
          }
          rows.push({ driver_id: driver.id, platform, gamertag: tag });
          lines.push(`${name}: ${platform} \`${tag}\`${current ? ` (was \`${current}\`)` : ""}`);
        }
      }

      if (apply && rows.length > 0) {
        const { error } = await supabase
          .schema("pitboss")
          .from("driver_gamertags")
          .upsert(rows, { onConflict: "driver_id,platform" });
        if (error) return { content: `Couldn't save the gamertags: ${error.message}` };
      }

      const shown = lines.slice(0, 25).join("\n");
      const more = lines.length > 25 ? `\n…and ${lines.length - 25} more` : "";
      return {
        content: [
          apply ? `**Saved ${rows.length} gamertag(s).**` : `**Preview — ${rows.length} to save.** Run again with \`apply:true\` to save.`,
          shown + more,
          unchanged > 0 ? `${unchanged} already up to date.` : null,
          noDriver.length > 0
            ? `No PitBoss driver for ${noDriver.length} poster(s): ${noDriver.slice(0, 10).join(" ")}${noDriver.length > 10 ? " …" : ""} (they need to use the bot once).`
            : null,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 1900),
      };
    },
  };
});
