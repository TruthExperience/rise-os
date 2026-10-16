// src/app/api/discord/register-commands/route.ts
//
// Registers /setup, /division, /signups (open, resume, status, list, close, invite,
// tracks, test), /signup (photos), /timetrial, /steward and /appeal with
// Discord. Each command is POSTed BY NAME, which overwrites that one command
// and leaves every other registered command alone, so this contains EVERY
// option/subcommand of each command listed here, not just the new ones.
//
// (Do NOT replace this with a bulk PUT of the whole command list: a bulk PUT
// deletes every command that isn't in the list.)
//
// Two ways to call it after deploying:
//   1. Browser / link:
//        https://<your-domain>/api/discord/register-commands?secret=<REGISTER_COMMANDS_SECRET>
//   2. curl:
//        curl -X POST https://<your-domain>/api/discord/register-commands \
//          -H "Authorization: Bearer $REGISTER_COMMANDS_SECRET"
//
// Env: PITBOSS_DISCORD_BOT_TOKEN, PITBOSS_DISCORD_APPLICATION_ID (or
//      DISCORD_APPLICATION_ID), REGISTER_COMMANDS_SECRET (any long random
//      string, you choose it)
//      DISCORD_GUILD_ID (optional: set to register in ONE server and it
//                        updates instantly. Omit for a global command, which
//                        is what every league needs. A guild-scoped command
//                        does NOT show up in DMs with the bot or in other
//                        servers, so leave it unset for /setup and /signups
//                        to work in all leagues and for /signup photos and
//                        /timetrial submit to work from a DM. A guild-scoped
//                        command also overrides a global one of the same
//                        name in that server.)

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// Allow time for rate-limit waits while registering several commands.
export const maxDuration = 60;

// /setup. Every option is optional: the handler (src/lib/discord/commands/
// setup.ts) auto-detects channels/roles by name and keeps saved values.
// Option types: 3 = STRING, 5 = BOOLEAN, 7 = CHANNEL, 8 = ROLE
// Channel types: 0 = text, 4 = category
const SETUP_COMMAND = {
  name: "setup",
  description: "Set up or update this league's PitBoss config (admins only)",
  default_member_permissions: "8", // Administrator
  options: [
    {
      type: 3,
      name: "name",
      description: "League name (default: the server name)",
      required: false,
    },
    {
      type: 7,
      name: "fia_category",
      description: "Category where steward tickets are created",
      channel_types: [4],
      required: false,
    },
    {
      type: 7,
      name: "reports_channel",
      description: "Incident reports channel",
      channel_types: [0],
      required: false,
    },
    {
      type: 7,
      name: "transcript_channel",
      description: "Ticket transcripts channel",
      channel_types: [0],
      required: false,
    },
    {
      type: 7,
      name: "appeals_channel",
      description: "Appeals channel",
      channel_types: [0],
      required: false,
    },
    {
      type: 7,
      name: "signup_channel",
      description: "Driver signups channel",
      channel_types: [0],
      required: false,
    },
    {
      type: 8,
      name: "steward_role",
      description: "Steward role",
      required: false,
    },
    {
      type: 5,
      name: "financial_system",
      description: "League uses a salary cap / wallets",
      required: false,
    },
  ],
};

// Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 5 = BOOLEAN, 6 = USER
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
      name: "invite",
      description: "Send the open signup round's invite to one racer (saved like a normal signup)",
      options: [
        {
          type: 6,
          name: "user",
          description: "Racer to invite",
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: "tracks",
      description: "Request time trial pictures on the open round (nobody is re-invited)",
      options: [
        {
          type: 3,
          name: "tracks",
          description: "Up to 3 tracks, separated by commas",
          required: true,
        },
        {
          type: 5,
          name: "notify",
          description: "Also DM drivers who already signed up (default: no)",
          required: false,
        },
      ],
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
          description: "Up to 3 tracks to request pictures of (commas), or 'random' (default: none)",
          required: false,
        },
      ],
    },
  ],
};

// Driver-facing. Same registration as /timetrial: no extra DM settings, so it
// works in a DM with the bot as well as in a league server (global scope).
// `league` is only used in a DM, when the driver is signed up in more than one
// league and has to say which one these screenshots are for.
// Option types: 1 = SUB_COMMAND, 3 = STRING, 11 = ATTACHMENT
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
        {
          type: 3,
          name: "league",
          description:
            "Which league, e.g. wsc — only needed in a DM if you're signed up in more than one",
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

// /steward: `evidence` (link) and `evidence_file` are BOTH optional on
// report and respond. Discord enforces "required" before the bot's code runs,
// so if `evidence` were required a file-only report would be impossible; the
// "at least one of the two" rule is enforced in steward.ts instead.
// Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 5 = BOOLEAN,
//               6 = USER, 11 = ATTACHMENT
const STEWARD_COMMAND = {
  name: "steward",
  description: "Report and check race incidents",
  options: [
    {
      type: 1,
      name: "report",
      description: "File an incident report",
      options: [
        {
          type: 3,
          name: "type",
          description: "Incident type (e.g. Collision / Contact, Track Limits)",
          required: true,
        },
        {
          type: 3,
          name: "description",
          description: "What happened",
          required: true,
        },
        {
          type: 6,
          name: "accused",
          description: "Driver the report is against",
          required: true,
        },
        {
          type: 4,
          name: "lap",
          description: "Lap number",
          required: true,
        },
        {
          type: 4,
          name: "round",
          description: "Round number",
          required: true,
        },
        {
          type: 3,
          name: "evidence",
          description: "POV clip / evidence link (https://...) — provide this or evidence_file",
          required: false,
        },
        {
          type: 11,
          name: "evidence_file",
          description: "Screenshot or video file — provide this or evidence (link)",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "status",
      description: "Show open incidents for this league",
    },
    {
      type: 1,
      name: "close",
      description: "Close this incident ticket and save a transcript (run inside the ticket)",
    },
    {
      type: 1,
      name: "transcript",
      description: "Show the transcript for this incident ticket (run inside the ticket)",
    },
    {
      type: 1,
      name: "delete",
      description: "Delete this incident ticket channel (must be closed first)",
    },
    {
      type: 1,
      name: "respond",
      description: "Submit your defense if you've been named in an incident (run inside the ticket)",
      options: [
        {
          type: 3,
          name: "response",
          description: "Your side of what happened",
          required: true,
        },
        {
          type: 3,
          name: "evidence",
          description: "Link to your own POV clip / evidence (https://...) — provide this or evidence_file",
          required: false,
        },
        {
          type: 3,
          name: "incident",
          description:
            "Ticket number (e.g. 0007) — required unless run inside the ticket channel",
          required: false,
        },
        {
          type: 11,
          name: "evidence_file",
          description: "Screenshot or video file — provide this or evidence (link)",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "analyse",
      description: "Run AI steward analysis on this incident (run inside the ticket)",
    },
    {
      type: 1,
      name: "verdict",
      description: "Record the final steward verdict (run inside the ticket)",
      options: [
        {
          type: 3,
          name: "verdict",
          description: "The ruling",
          required: true,
        },
        {
          type: 3,
          name: "penalty",
          description: "Penalty issued, if any",
          required: false,
        },
        {
          type: 4,
          name: "points",
          description: "Penalty points",
          required: false,
        },
        {
          type: 4,
          name: "time_penalty_seconds",
          description: "Time penalty in seconds (guilty verdicts only)",
          required: false,
          min_value: 0,
          max_value: 3600,
        },
        {
          type: 4,
          name: "position_drop",
          description: "Finishing positions lost (guilty verdicts only)",
          required: false,
          min_value: 0,
          max_value: 30,
        },
        {
          type: 4,
          name: "grid_penalty_places",
          description: "Grid places lost at the next race (guilty verdicts only)",
          required: false,
          min_value: 0,
          max_value: 30,
        },
        {
          type: 5,
          name: "grid_penalty_back",
          description: "Start from the back of the grid (guilty verdicts only)",
          required: false,
        },
        {
          type: 3,
          name: "notes",
          description: "Steward notes",
          required: false,
        },
        {
          type: 3,
          name: "override_reason",
          description: "Reason for overriding the AI suggestion, if applicable",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "assign",
      description: "Assign this incident ticket to a steward (head steward only, run inside the ticket)",
      options: [
        {
          type: 6,
          name: "steward",
          description: "Steward to assign this ticket to",
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: "requesthelp",
      description: "Flag this ticket for help from other stewards (run inside the ticket)",
      options: [
        {
          type: 3,
          name: "note",
          description: "What you need help with",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "adduser",
      description: "Add a user to this incident ticket channel (run inside the ticket)",
      options: [
        {
          type: 6,
          name: "user",
          description: "User to add to the ticket",
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: "removeuser",
      description: "Remove a user from this incident ticket channel (run inside the ticket)",
      options: [
        {
          type: 6,
          name: "user",
          description: "User to remove from the ticket",
          required: true,
        },
        {
          type: 5,
          name: "force",
          description: "Confirm removing the ticket opener (reporter) — required if removing them",
          required: false,
        },
      ],
    },
  ],
};

// /appeal: `evidence` (link) and `evidence_file` are optional on `file`.
const APPEAL_COMMAND = {
  name: "appeal",
  description: "File or review an appeal on a resolved incident",
  options: [
    {
      type: 1,
      name: "file",
      description: "File an appeal on a resolved or dismissed incident",
      options: [
        {
          type: 3,
          name: "incident",
          description: "Ticket number (e.g. 0007)",
          required: true,
        },
        {
          type: 3,
          name: "reason",
          description: "Why you're appealing this incident",
          required: true,
        },
        {
          type: 3,
          name: "evidence",
          description: "Optional new evidence link (https://...)",
          required: false,
        },
        {
          type: 11,
          name: "evidence_file",
          description: "Optional new evidence file (screenshot or video)",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "status",
      description: "List open appeals for this league",
    },
    {
      type: 1,
      name: "review",
      description: "Steward: rule on an open appeal",
      options: [
        {
          type: 3,
          name: "incident",
          description: "Incident short ID",
          required: true,
        },
        {
          type: 3,
          name: "decision",
          description: "Appeal decision",
          required: true,
          choices: [
            { name: "Upheld", value: "upheld" },
            { name: "Overturned", value: "overturned" },
            { name: "Dismissed", value: "dismissed" },
          ],
        },
        {
          type: 3,
          name: "new_verdict",
          description: "Revised verdict (if overturned)",
          required: false,
        },
        {
          type: 3,
          name: "new_penalty",
          description: "Revised penalty (if overturned)",
          required: false,
        },
        {
          type: 4,
          name: "new_points",
          description: "Revised penalty points (if overturned)",
          required: false,
        },
        {
          type: 4,
          name: "new_time_penalty_seconds",
          description: "Revised time penalty in seconds (if overturned and guilty)",
          required: false,
          min_value: 0,
          max_value: 3600,
        },
        {
          type: 4,
          name: "new_position_drop",
          description: "Revised positions lost (if overturned and guilty)",
          required: false,
          min_value: 0,
          max_value: 30,
        },
        {
          type: 4,
          name: "new_grid_penalty_places",
          description: "Revised grid places lost (if overturned and guilty)",
          required: false,
          min_value: 0,
          max_value: 30,
        },
        {
          type: 5,
          name: "new_grid_penalty_back",
          description: "Revised back-of-grid start (if overturned and guilty)",
          required: false,
        },
        {
          type: 3,
          name: "notes",
          description: "Steward notes on the decision",
          required: false,
        },
      ],
    },
  ],
};

// /division: create | list | assign | remove | link | delete (handlers in
// src/lib/discord/commands/division.ts, dispatched as division_<sub>).
// `reserve` on assign/remove targets the division's reserve list instead of
// its main drivers. Reserves don't count against max_drivers.
// Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 5 = BOOLEAN,
//               6 = USER, 7 = CHANNEL, 8 = ROLE
const DIVISION_COMMAND = {
  name: "division",
  description: "Manage league divisions (owners and commissioners)",
  options: [
    {
      type: 1,
      name: "create",
      description: "Create a division",
      options: [
        { type: 3, name: "code", description: "Division code, e.g. T1", required: true },
        { type: 3, name: "name", description: "Display name (default: the code)", required: false },
        { type: 4, name: "max_drivers", description: "Maximum main drivers", required: false },
        { type: 4, name: "tier_order", description: "Tier order (1 = top)", required: false },
        { type: 5, name: "create_discord", description: "Create the Discord channel and role (default: yes)", required: false },
      ],
    },
    { type: 1, name: "list", description: "List divisions with driver and reserve counts" },
    {
      type: 1,
      name: "assign",
      description: "Assign a driver to a division",
      options: [
        { type: 6, name: "driver", description: "Driver to assign", required: true },
        { type: 3, name: "division", description: "Division code", required: true },
        { type: 5, name: "reserve", description: "Add as a reserve instead of a main driver (default: no)", required: false },
      ],
    },
    {
      type: 1,
      name: "remove",
      description: "Remove a driver from their division",
      options: [
        { type: 6, name: "driver", description: "Driver to remove", required: true },
        { type: 5, name: "reserve", description: "Remove a reserve instead of a main driver (default: no)", required: false },
        { type: 3, name: "division", description: "Division code (required when reserve is true)", required: false },
      ],
    },
    {
      type: 1,
      name: "link",
      description: "Update a division's check-in channel, role or limits",
      options: [
        { type: 3, name: "code", description: "Division code", required: true },
        { type: 7, name: "checkin_channel", description: "Check-in channel", channel_types: [0], required: false },
        { type: 8, name: "role", description: "Division role", required: false },
        { type: 4, name: "max_drivers", description: "Maximum main drivers", required: false },
        { type: 3, name: "name", description: "Display name", required: false },
      ],
    },
    {
      type: 1,
      name: "delete",
      description: "Delete a division",
      options: [
        { type: 3, name: "code", description: "Division code", required: true },
        { type: 5, name: "delete_discord", description: "Also delete its Discord channel and role", required: false },
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
    options: string[];
  }[] = [];

  for (const command of [
    SETUP_COMMAND,
    SIGNUPS_COMMAND,
    SIGNUP_COMMAND,
    TIMETRIAL_COMMAND,
    STEWARD_COMMAND,
    APPEAL_COMMAND,
    DIVISION_COMMAND,
  ]) {
    // Discord rate-limits command writes (a 429 comes back with
    // retry_after in seconds). Wait that long and try again, up to 4 times,
    // instead of failing the whole registration part-way through.
    let res: Response;
    let json: any = {};
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });
      json = await res.json().catch(() => ({}));

      if (res.status !== 429 || attempt >= 4) break;

      const waitSeconds = Math.min(Number(json?.retry_after ?? 2) + 0.5, 10);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }

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
      // Subcommand names for /signups etc., option names for /setup.
      options: (json.options ?? []).map((o: { name: string }) => o.name),
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
