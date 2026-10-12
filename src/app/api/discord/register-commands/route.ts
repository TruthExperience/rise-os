// src/app/api/discord/register-commands/route.ts
//
// Registers /signups (open, resume, status, list, close, test) with Discord.
// POSTing a command with an existing name overwrites it, so this contains
// EVERY /signups subcommand, not just the new one.
//
// Call it once after deploying:
//   curl -X POST https://<your-domain>/api/discord/register-commands \
//     -H "Authorization: Bearer $REGISTER_COMMANDS_SECRET"
//
// Env: PITBOSS_DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID,
//      REGISTER_COMMANDS_SECRET (any long random string, you choose it)
//      DISCORD_GUILD_ID (optional: set to register in ONE server, e.g. VRC,
//                        and it updates instantly. Omit for a global command.)

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 6 = USER
const SIGNUPS_COMMAND = {
  name: "signups",
  description: "Manage season signups (owners only)",
  options: [
    {
      type: 1,
      name: "open",
      description: "Open signups and DM every league member",
      options: [
        {
          type: 4,
          name: "season",
          description: "Season number (default: the league's latest upcoming season)",
          required: false,
        },
        {
          type: 3,
          name: "message",
          description: "Custom DM text (optional)",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "resume",
      description: "Keep sending queued DMs after a timeout",
    },
    {
      type: 1,
      name: "status",
      description: "Counts for the open signup round",
    },
    {
      type: 1,
      name: "list",
      description: "Names for the open signup round",
      options: [
        {
          type: 3,
          name: "show",
          description: "Which group to list (default: signed up)",
          required: false,
          choices: [
            { name: "Signed up", value: "signed_up" },
            { name: "Declined", value: "declined" },
            { name: "No answer yet", value: "pending" },
            { name: "Couldn't DM", value: "dm_failed" },
            { name: "Everyone", value: "all" },
          ],
        },
      ],
    },
    {
      type: 1,
      name: "close",
      description: "Close the open signup round",
    },
    {
      type: 1,
      name: "test",
      description: "Send one test signup invite to a single user (nothing is saved)",
      options: [
        {
          type: 6,
          name: "user",
          description: "Who to send the test invite to",
          required: true,
        },
        {
          type: 4,
          name: "season",
          description: "Season number for the invite (default: 2)",
          required: false,
        },
      ],
    },
  ],
};

export async function POST(req: NextRequest) {
  const secret = process.env.REGISTER_COMMANDS_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId) {
    return NextResponse.json(
      { error: "Set PITBOSS_DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID" },
      { status: 500 }
    );
  }

  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(SIGNUPS_COMMAND),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[register-commands] failed:", res.status, json);
    return NextResponse.json(
      { error: "Registration failed", status: res.status, details: json },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    scope: guildId ? `guild ${guildId}` : "global",
    commandId: json.id,
  });
}
