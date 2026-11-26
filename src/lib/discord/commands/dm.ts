// dm.ts
//
// /dm — sends a direct message to a Discord user from the PitBoss bot.
//
// Why this exists: every other DM the bot sends is a side effect of something
// else (a ticket verdict, an appeal decision, a check-in reminder), so there
// was no way for a league owner to just reach out to someone — e.g. a new
// league's owner who has questions about how PitBoss works — without going
// through a ticket. This is that missing primitive, deliberately gated to
// league owners so the bot's identity can't be used to impersonate PitBoss.
//
// Gate is owner flags OR Discord ADMINISTRATOR. The Administrator fallback
// matters: a brand-new league typically has no pitboss.driver_leagues rows yet
// (CFRL has none), so an owner who hasn't been provisioned as a driver would
// otherwise be locked out of their own league's commands.

import { registerCommand } from "./registry";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import { sendDirectMessage } from "../tickets";

const OWNER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;
const ADMINISTRATOR = BigInt(1) << BigInt(3);

// Discord rejects message content over 2000 characters; leaving headroom keeps
// a paste with a trailing newline from failing at the API instead of here.
const MAX_MESSAGE_LENGTH = 1800;

function hasDiscordAdmin(permissions: string): boolean {
  try {
    return (BigInt(permissions || "0") & ADMINISTRATOR) !== BigInt(0);
  } catch {
    return false;
  }
}

registerCommand("dm", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  const allowed =
    hasAnyFlag(membership, [...OWNER_FLAGS]) ||
    hasDiscordAdmin(ctx.memberPermissions ?? "0");

  if (!allowed) {
    return {
      content: "Only the league owner, co-owners or commissioners can send a DM through the bot.",
      ephemeral: true,
    };
  }

  const targetId = ctx.options.user as string | undefined;
  const message = String(ctx.options.message ?? "").trim();

  if (!targetId) {
    return { content: "Pick someone to DM.", ephemeral: true };
  }
  if (!message) {
    return { content: "The message is empty — nothing was sent.", ephemeral: true };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      content: `That message is ${message.length} characters; Discord's limit is 2000, so keep it under ${MAX_MESSAGE_LENGTH}. Nothing was sent.`,
      ephemeral: true,
    };
  }
  if (targetId === ctx.discordUserId) {
    return { content: "That's you — pick someone else.", ephemeral: true };
  }

  const sent = await sendDirectMessage(targetId, message);

  if (!sent) {
    // sendDirectMessage returns false both when the token is missing and when
    // the recipient has DMs from server members disabled — a normal outcome,
    // but the invoker needs to know it did not arrive rather than assume it did.
    return {
      content: `Couldn't DM <@${targetId}> — they may have DMs from server members turned off, or the bot token isn't configured. Nothing was delivered.`,
      ephemeral: true,
    };
  }

  const targetUsername = ctx.resolvedUsers[targetId]?.username;
  return {
    content: `Sent to <@${targetId}>${targetUsername ? ` (${targetUsername})` : ""}.`,
    ephemeral: true,
  };
});
