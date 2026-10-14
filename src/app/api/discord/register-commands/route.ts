// src/app/api/discord/register-commands/route.ts
//
// Registers /signups (open, resume, status, list, close, test), /signup
// (photos) and /timetrial with Discord. POSTing a command with an existing
// name overwrites it, so this contains EVERY subcommand of each command, not
// just the new ones.
//
// Two ways to call it after deploying:
//   1. Browser / link:
//        https://<your-domain>/api/discord/register-commands?secret=<REGISTER_COMMANDS_SECRET>
//   2. curl:
//        curl -X POST https://<your-domain>/api/discord/register-commands \
//          -H "Authorization: Bearer $REGISTER_COMMANDS_SECRET"
//
// Env: PITBOSS_DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID,
//      REGISTER_COMMANDS_SECRET (any long random string, you choose it)
//      DISCORD_GUILD_ID (optional: set to register in ONE server, e.g. VRC,
//                        and it updates instantly. Omit for a global command.
//                        A guild-scoped command does NOT show up in DMs with
//                        the bot, so leave it unset for /signup photos and
//                        /timetrial submit to work from a DM.)

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
        {
          type: 3,
          name: "tracks",
          description: "Up to 3 tracks drivers send pictures of, separated by commas (optional)",
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
        {
          type: 3,
          name: "tracks",
          description: "Up to 3 tracks to request pictures of, separated by commas (default: 3 random)",
          required: false,
        },
      ],
    },
  ],
};

// Driver-facing. Same registration as /timetrial: no extra DM settings, so it
// works in a DM with the bot as well as in a league server (global scope).
// Option types: 1 = SUB_COMMAND, 11 = ATTACHMENT
const SIGNUP_COMMAND = {
  name: "signup",
  description: "Signup tools for drivers",
  options: [
    {
      type: 1,
      name: "photos",
      description: "Send your signup screenshots (works in DMs too)",
      options: [
        {
          type: 11,
          name: "screenshot_1",
          description: "First screenshot",
          required: true,
        },
        {
          type: 11,
          name: "screenshot_2",
          description: "Second screenshot (optional)",
          required: false,
        },
        {
          type: 11,
          name: "screenshot_3",
          description: "Third screenshot (optional)",
          required: false,
        },
      ],
    },
  ],
};

// Option types: 1 = SUB_COMMAND, 3 = STRING, 11 = ATTACHMENT
const TIMETRIAL_COMMAND = {
  name: "timetrial",
  description: "Log and compare time trial laps",
  options: [
    {
      type: 1,
      name: "submit",
      description: "Submit a lap with a screenshot or clip (works in DMs too)",
      options: [
        { type: 3, name: "track", description: "Track name", required: true },
        {
          type: 3,
          name: "time",
          description: "Lap time, e.g. 1:23.456 or 83.456",
          required: true,
        },
        {
          type: 11,
          name: "screenshot",
          description: "Screenshot or clip proving the lap",
          required: true,
        },
        {
          type: 3,
          name: "car_class",
          description: "Car class (optional)",
          required: false,
        },
        { type: 3, name: "notes", description: "Notes (optional)", required: false },
      ],
    },
    {
      type: 1,
      name: "leaderboard",
      description: "Top 10 best laps for a track",
      options: [
        { type: 3, name: "track", description: "Track name", required: true },
      ],
    },
  ],
};

async function register(): Promise<NextResponse> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  const appId =
    process.env.PITBOSS_DISCORD_APPLICATION_ID ??
    process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId) {
    return NextResponse.json(
      {
        error:
          "Set PITBOSS_DISCORD_BOT_TOKEN and PITBOSS_DISCORD_APPLICATION_ID",
      },
      { status: 500 }
    );
  }

  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const results: {
    command: string;
    commandId: string;
    subcommands: string[];
  }[] = [];

  for (const command of [SIGNUPS_COMMAND, SIGNUP_COMMAND, TIMETRIAL_COMMAND]) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[register-commands] failed:", command.name, res.status, json);
      return NextResponse.json(
        {
          error: "Registration failed",
          command: command.name,
          status: res.status,
          details: json,
          registeredSoFar: results,
        },
        { status: 502 }
      );
    }

    results.push({
      command: command.name,
      commandId: json.id,
      subcommands: (json.options ?? []).map((o: { name: string }) => o.name),
    });
  }

  return NextResponse.json({
    ok: true,
    scope: guildId ? `guild ${guildId}` : "global",
    commands: results,
  });
}

// curl / scripts: Authorization: Bearer <secret>
export async function POST(req: NextRequest) {
  const secret = process.env.REGISTER_COMMANDS_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return register();
}

// Browser / link: ?secret=<secret>
export async function GET(req: NextRequest) {
  const secret = process.env.REGISTER_COMMANDS_SECRET;
  if (!secret || req.nextUrl.searchParams.get("secret") !== secret) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return register();
}
