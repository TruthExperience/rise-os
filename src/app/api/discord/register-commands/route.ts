// src/app/api/discord/register-commands/route.ts
//
// Registers /setup, /division, /signups (open, resume, status, list, close, invite,
// tracks, test), /signup (photos), /timetrial, /steward and /appeal and /progression
// and /ddv with Discord. Each command is POSTed BY NAME, which overwrites that one command
// and leaves every other registered command alone, so this contains EVERY
// option/subcommand of each command listed here, not just the new ones.
//
// (Do NOT replace this with a bulk PUT of the whole command list: a bulk PUT
// deletes every command that isn't in the list.)
//
// The rest of what the router implements — /ban, /kick, /checkin, /results,
// /calendar, /roles and the others — is defined in ./restored.ts and spread
// into the list below. See the header there: those definitions were deleted
// from this file in 19526c6 while their handlers stayed.
//
// Safe to call as often as you like: it reads the commands Discord already has
// and only rewrites the ones whose definition here differs, a few at a time,
// inside a time budget. If any are still pending when the budget runs out, the
// response lists them — call the same URL again to finish.
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
import { RESTORED_COMMANDS } from "./restored";

export const dynamic = "force-dynamic";
// Allow time for rate-limit waits while registering several commands.
export const maxDuration = 60;

// 39 commands (17 above + RESTORED_COMMANDS) POSTed one after another, each
// with up to five 429 waits of up to 10s, does not fit in 60 seconds — Vercel
// killed the function and the browser got a bare 504 with nothing to show for
// it. Three things keep it inside the budget:
//   - read what Discord already has and only write what is missing or changed,
//     so a repeat call is one GET and no writes;
//   - write the remaining commands a few at a time instead of in single file;
//   - stop starting writes at REGISTER_BUDGET_MS and answer with what is left,
//     so a second call can finish instead of Vercel timing the request out.
const REGISTER_CONCURRENCY = 6;
const REGISTER_BUDGET_MS = 45_000;
const DISCORD_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch with a timeout, so one stalled Discord request can't eat the budget. */
async function discordFetch(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when every field we would send is already what Discord has stored.
 * Discord fills in defaults we never send (required: false, nsfw: false,
 * description_localizations, …), so only our own keys are compared, and a null
 * or undefined on our side means "no opinion".
 */
function matchesRegistered(want: unknown, have: unknown): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return false;
    return want.every((item, i) => matchesRegistered(item, have[i]));
  }
  if (want !== null && typeof want === "object") {
    if (have === null || typeof have !== "object") return false;
    return Object.entries(want as Record<string, unknown>).every(([key, value]) =>
      value === null || value === undefined
        ? true
        : matchesRegistered(value, (have as Record<string, unknown>)[key])
    );
  }
  return want === have;
}

/** Commands Discord already has, by name. null when the lookup itself failed. */
async function fetchRegisteredCommands(url: string, token: string) {
  try {
    const res = await discordFetch(
      `${url}?limit=200`,
      { method: "GET", headers: { Authorization: `Bot ${token}` } },
      DISCORD_TIMEOUT_MS
    );
    if (!res.ok) {
      console.error("[register-commands] list failed:", res.status, await res.text());
      return null;
    }
    const json: unknown = await res.json().catch(() => null);
    if (!Array.isArray(json)) return null;
    const byName = new Map<string, unknown>();
    for (const command of json) {
      if (command && typeof command.name === "string") byName.set(command.name, command);
    }
    return byName;
  } catch (err) {
    console.error("[register-commands] list threw:", err);
    return null;
  }
}

type RegisterOutcome =
  | { kind: "ok"; command: string; json: any }
  | { kind: "failed"; command: string; status: number; json: any }
  | { kind: "pending"; command: string };

/**
 * POST one command by name. Discord rate-limits command writes (a 429 comes
 * back with retry_after in seconds), so wait that long and try again — but give
 * up while the caller still has budget to answer, leaving the command pending
 * rather than letting the whole function time out.
 */
async function registerCommand(
  url: string,
  token: string,
  command: { name: string },
  deadline: number
): Promise<RegisterOutcome> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let json: any = {};
    try {
      res = await discordFetch(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(command),
        },
        DISCORD_TIMEOUT_MS
      );
      json = await res.json().catch(() => ({}));
    } catch (err) {
      return { kind: "failed", command: command.name, status: 0, json: { error: String(err) } };
    }

    if (res.status !== 429) {
      return res.ok
        ? { kind: "ok", command: command.name, json }
        : { kind: "failed", command: command.name, status: res.status, json };
    }

    const waitSeconds = Math.min(Number(json?.retry_after ?? 2) + 0.5, 10);
    if (attempt >= 4 || Date.now() + waitSeconds * 1000 > deadline) {
      return { kind: "pending", command: command.name };
    }
    await sleep(waitSeconds * 1000);
  }
}

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
      name: "teams",
      description: "DM signed-up drivers the team request buttons (open round)",
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
      name: "open",
      description: "Reopen a closed incident ticket (run inside the ticket)",
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
      name: "finalize_round",
      description: "Finalize a round after all verdicts are resolved (closes appeals, runs DDV)",
      options: [
        { type: 4, name: "round", description: "Round number", required: true },
        { type: 4, name: "season", description: "Season number (defaults to latest)", required: false },
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

// /division: create | list | assign | remove | link | sync | delete (handlers
// in src/lib/discord/commands/division.ts, dispatched as division_<sub>).
// `sync` creates the Discord role/category/check-in channel that rows already
// in the database are missing, so divisions seeded by SQL get channels too.
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
        { type: 7, name: "incident_channel", description: "This division's incident reports channel", channel_types: [0], required: false },
        { type: 7, name: "transcript_channel", description: "This division's ticket transcripts channel", channel_types: [0], required: false },
        { type: 8, name: "role", description: "Division role", required: false },
        { type: 4, name: "max_drivers", description: "Maximum main drivers", required: false },
        { type: 3, name: "name", description: "Display name", required: false },
      ],
    },
    {
      type: 1,
      name: "sync",
      description: "Create the missing Discord channel, category and role for divisions in the database",
      options: [
        { type: 3, name: "code", description: "Only this division, e.g. T1 F1 26 (default: every division in the league)", required: false },
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

// /gamertags import: reads a gamertags channel and saves what each person
// posted (owners, co-owners, commissioners, stewards and head stewards only;
// the handler checks). Without apply it only previews.
// /progression. Owner/co-owner gating happens in the handler
// (src/lib/discord/commands/progression.ts).
// Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 5 = BOOLEAN
const PROGRESSION_COMMAND = {
  name: "progression",
  description: "Season progression: preview, approve and apply division moves (owners)",
  options: [
    {
      type: 1,
      name: "preview",
      description: "Dry-run the progression calc for a season (saves nothing)",
      options: [{ type: 3, name: "season", description: "Season, e.g. 1", required: true }],
    },
    {
      type: 1,
      name: "propose",
      description: "Run the calc and save the proposals",
      options: [{ type: 3, name: "season", description: "Season, e.g. 1", required: true }],
    },
    {
      type: 1,
      name: "list",
      description: "List proposals",
      options: [
        {
          type: 3,
          name: "status",
          description: "Default: proposed",
          required: false,
          choices: [
            { name: "proposed", value: "proposed" },
            { name: "approved", value: "approved" },
            { name: "applied", value: "applied" },
            { name: "rejected", value: "rejected" },
            { name: "declined", value: "declined" },
          ],
        },
        { type: 3, name: "season", description: "Filter by season", required: false },
      ],
    },
    {
      type: 1,
      name: "approve",
      description: "Approve a proposal",
      options: [{ type: 3, name: "proposal", description: "Proposal ID (first 8 characters is fine)", required: true }],
    },
    {
      type: 1,
      name: "reject",
      description: "Reject a proposal",
      options: [{ type: 3, name: "proposal", description: "Proposal ID (first 8 characters is fine)", required: true }],
    },
    {
      type: 1,
      name: "decline",
      description: "Mark a proposal declined (driver declined the move)",
      options: [{ type: 3, name: "proposal", description: "Proposal ID (first 8 characters is fine)", required: true }],
    },
    {
      type: 1,
      name: "apply",
      description: "Apply an approved proposal (dry run unless dry_run is False)",
      options: [
        { type: 3, name: "proposal", description: "Proposal ID (first 8 characters is fine)", required: true },
        { type: 5, name: "dry_run", description: "Default True. Set False to commit", required: false },
        { type: 4, name: "dispute_hours", description: "Override the dispute window (hours)", required: false },
      ],
    },
    {
      type: 1,
      name: "finalize",
      description: "Finalize a provisional conversion after its dispute window",
      options: [
        { type: 3, name: "conversion", description: "Conversion ID (first 8 characters is fine)", required: true },
        { type: 5, name: "dry_run", description: "Default True. Set False to commit", required: false },
      ],
    },
  ],
};

// /regression. Owner/co-owner gating happens in the handler
// (src/lib/discord/commands/regression.ts).
// Option types: 1 = SUB_COMMAND, 3 = STRING, 10 = NUMBER
const REGRESSION_COMMAND = {
  name: "regression",
  description: "Off-season DDV regression: set rates, preview, apply (owners)",
  options: [
    {
      type: 1,
      name: "set",
      description: "Set the regression rate for a tier",
      options: [
        { type: 3, name: "tier", description: "Tier name as shown on DDV records, e.g. F1, Academy", required: true },
        { type: 10, name: "decay_pct", description: "Off-season decay percent (0-100)", required: true, min_value: 0, max_value: 100 },
        { type: 10, name: "inactivity_pct", description: "Extra decay percent per inactive season", required: false, min_value: 0, max_value: 100 },
      ],
    },
    { type: 1, name: "list", description: "Show this league's regression rates" },
    {
      type: 1,
      name: "preview",
      description: "Dry-run the regression for a season (saves nothing)",
      options: [{ type: 3, name: "season", description: "Season being closed out", required: true }],
    },
    {
      type: 1,
      name: "apply",
      description: "Apply the regression for a season (commits)",
      options: [{ type: 3, name: "season", description: "Season being closed out", required: true }],
    },
  ],
};

// /ddv: view | edit | team | leaderboard | guide (handlers in
// src/lib/discord/commands/ddv.ts, dispatched as ddv_<sub>). `guide` posts the
// short explainer into the channel on purpose (not ephemeral) so it can be
// pinned. POSTing /ddv by name replaces the whole command, so every existing
// subcommand has to stay listed here.
// Option types: 1 = SUB_COMMAND, 3 = STRING, 6 = USER, 10 = NUMBER
const DDV_COMMAND = {
  name: "ddv",
  description: "Dynamic Driver Value: look up, adjust and explain DDV",
  options: [
    {
      type: 1,
      name: "view",
      description: "Show a driver's DDV (default: your own)",
      options: [
        {
          type: 6,
          name: "driver",
          description: "Driver to look up (default: you)",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "edit",
      description: "Manually set a driver's DDV (owners)",
      options: [
        { type: 6, name: "driver", description: "Driver whose DDV to change", required: true },
        { type: 10, name: "ddv", description: "New DDV value", required: true, min_value: 0 },
        { type: 3, name: "reason", description: "Why (required, it's logged)", required: true },
      ],
    },
    {
      type: 1,
      name: "team",
      description: "DDV of every driver on a team (Team Principals)",
      options: [
        { type: 3, name: "team", description: "Team name (default: your own team)", required: false },
        { type: 3, name: "season", description: "Season (default: current)", required: false },
      ],
    },
    { type: 1, name: "leaderboard", description: "League DDV leaderboard" },
    {
      type: 1,
      name: "guide",
      description: "Post the short DDV explainer so it can be pinned",
      // Only needed for leagues with several division configs (TRL); the
      // handler also accepts the division's own channel, and refuses with the
      // list of divisions when it can't tell which one applies.
      options: [
        {
          type: 3,
          name: "division",
          description: "Division to explain (only for leagues with several configs)",
          required: false,
        },
      ],
    },
  ],
};

// /cap. Subcommands in src/lib/discord/commands/cap.ts. Every option each
// handler reads is listed here: view falls back to your own franchise, edit
// needs a franchise and an amount (it refuses without them), league takes
// none, board filters by division and season.
// Option types: 1 = SUB_COMMAND, 3 = STRING, 10 = NUMBER
const CAP_COMMAND = {
  name: "cap",
  description: "Salary cap: a franchise's position, the league board, or an owner adjustment",
  options: [
    {
      type: 1,
      name: "view",
      description: "Show a franchise's cap position (default: your own)",
      options: [
        { type: 3, name: "franchise", description: "Franchise name or abbreviation", required: false },
      ],
    },
    {
      type: 1,
      name: "edit",
      description: "Set a franchise's cap amount (owners)",
      options: [
        { type: 3, name: "franchise", description: "Franchise name or abbreviation", required: true },
        { type: 10, name: "amount", description: "New cap amount", required: true, min_value: 0 },
      ],
    },
    {
      type: 1,
      name: "league",
      description: "League-wide cap summary by division",
    },
    {
      type: 1,
      name: "board",
      description: "Cap board for a division and season",
      options: [
        { type: 3, name: "division", description: "Division label, e.g. F1 or T1", required: false },
        { type: 3, name: "season", description: "Season, e.g. 26", required: false },
      ],
    },
  ],
};

// /roster. Subcommands in src/lib/discord/commands/roster.ts. assign reads
// driver, team, tier, season and principal; remove reads driver and season;
// view reads tier. The defaults the handler applies (Tier 1, S2) are left to it.
// Option types: 1 = SUB_COMMAND, 3 = STRING, 5 = BOOLEAN, 6 = USER
const ROSTER_COMMAND = {
  name: "roster",
  description: "Team rosters: view, assign or remove a driver",
  options: [
    {
      type: 1,
      name: "view",
      description: "Show the active roster",
      options: [
        { type: 3, name: "tier", description: "Only show this tier", required: false },
      ],
    },
    {
      type: 1,
      name: "assign",
      description: "Add a driver to a team's roster",
      options: [
        { type: 6, name: "driver", description: "Driver to add", required: true },
        { type: 3, name: "team", description: "Team name", required: true },
        { type: 3, name: "tier", description: "Roster tier (default: Tier 1)", required: false },
        { type: 3, name: "season", description: "Season (default: S2)", required: false },
        {
          type: 5,
          name: "principal",
          description: "Assign as team principal instead of a driver",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "remove",
      description: "Remove a driver from their roster",
      options: [
        { type: 6, name: "driver", description: "Driver to remove", required: true },
        { type: 3, name: "season", description: "Season (default: S2)", required: false },
      ],
    },
  ],
};

// /standings. A flat command in src/lib/discord/commands/standings.ts: it reads
// season and limit, and resolves the league's current season itself when no
// season is given.
// Option types: 3 = STRING, 4 = INTEGER
const STANDINGS_COMMAND = {
  name: "standings",
  description: "Driver and constructor standings for a season",
  options: [
    { type: 3, name: "season", description: "Season (default: the league's current one)", required: false },
    { type: 4, name: "limit", description: "How many rows to show", required: false, min_value: 1 },
  ],
};

// /sign-driver. Registered BY NAME, so this must list EVERY option the handler
// reads (src/lib/discord/commands/driver.ts): a POST replaces the whole
// command, and an option missing here simply never reaches the handler. It had
// dropped out of this file entirely, which is why seasons/signing_bonus and the
// bonus schedule could be read by the handler but never sent by Discord.
// Option types: 3 = STRING, 4 = INTEGER, 6 = USER, 10 = NUMBER
const SIGN_DRIVER_COMMAND = {
  name: "sign-driver",
  description: "Sign a driver to a franchise (employment — contracts/cap, not the EA car-class roster)",
  options: [
    {
      type: 6,
      name: "driver",
      description: "Driver to sign",
      required: true,
    },
    {
      type: 3,
      name: "franchise",
      description: "Franchise name or abbreviation (e.g. McLaren, or 'McLaren 25' if a division match is ambiguous)",
      required: true,
    },
    {
      type: 3,
      name: "season",
      description: "Season (e.g. 2026)",
      required: true,
    },
    {
      type: 3,
      name: "tier",
      description: "Contract/pricing tier (e.g. T1, T2, D1, Reserve) — league-specific",
      required: false,
    },
    {
      type: 10,
      name: "value",
      description: "Contract value per season; defaults to this driver's DDV floor",
      required: false,
      min_value: 1,
    },
    {
      type: 4,
      name: "seasons",
      description: "Deal length in seasons (default 1)",
      required: false,
      min_value: 1,
      max_value: 10,
    },
    {
      type: 10,
      name: "signing_bonus",
      description: "Signing bonus, paid once and debited from the wallet (default 0)",
      required: false,
      min_value: 0,
    },
    {
      type: 3,
      name: "bonus_schedule",
      description: 'Keyed bonuses as JSON, e.g. [{"key":"race_win","amount":30000}]',
      required: false,
    },
    {
      type: 3,
      name: "bonus_template",
      description: "Saved bonus template name, instead of bonus_schedule",
      required: false,
    },
  ],
};

// /release-driver. The counterpart of /sign-driver (src/lib/discord/commands/
// driver.ts): without it a mis-signed driver could be signed but never released
// from Discord. driver and reason are read directly; season is optional by
// design — the release is found by driver+league+released_at, and a season is
// only echoed back as a note, so it is not required here.
// Option types: 3 = STRING, 6 = USER
const RELEASE_DRIVER_COMMAND = {
  name: "release-driver",
  description: "Release a driver from their current franchise",
  options: [
    { type: 6, name: "driver", description: "Driver to release", required: true },
    {
      type: 3,
      name: "season",
      description: "Season, for the record only (not used to find the deal)",
      required: false,
    },
    { type: 3, name: "reason", description: "Reason for release", required: false },
  ],
};

// /dm. A flat command in src/lib/discord/commands/dm.ts — sends a direct
// message from the bot to one user, gated to league owners (owner/co-owner/
// commissioner flags, or Discord Administrator so an unprovisioned league owner
// isn't locked out of their own server). message is capped below Discord's 2000
// character ceiling so an over-long paste fails with a clear reply instead of a
// 400 from the API.
// Option types: 3 = STRING, 6 = USER
const DM_COMMAND = {
  name: "dm",
  description: "Send a direct message from the bot to a user (owners)",
  options: [
    { type: 6, name: "user", description: "Who to DM", required: true },
    {
      type: 3,
      name: "message",
      description: "What to send",
      required: true,
      max_length: 1800,
    },
  ],
};

// Option types: 1 = SUB_COMMAND, 5 = BOOLEAN, 7 = CHANNEL
const GAMERTAGS_COMMAND = {
  name: "gamertags",
  description: "Save drivers' gamertags from a gamertags channel",
  options: [
    {
      type: 1,
      name: "import",
      description: "Read a gamertags channel and save each person's gamertags",
      options: [
        { type: 7, name: "channel", description: "Gamertags channel (default: this channel)", channel_types: [0], required: false },
        { type: 5, name: "apply", description: "Save them (default: preview only)", required: false },
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

  // Narrowed once here: the workers below are closures, and TypeScript drops
  // the `if (!token)` narrowing inside those.
  const botToken: string = token;

  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const commands = [
    SETUP_COMMAND,
    SIGNUPS_COMMAND,
    SIGNUP_COMMAND,
    SIGN_DRIVER_COMMAND,
    RELEASE_DRIVER_COMMAND,
    DM_COMMAND,
    TIMETRIAL_COMMAND,
    STEWARD_COMMAND,
    APPEAL_COMMAND,
    DIVISION_COMMAND,
    CAP_COMMAND,
    ROSTER_COMMAND,
    STANDINGS_COMMAND,
    GAMERTAGS_COMMAND,
    PROGRESSION_COMMAND,
    REGRESSION_COMMAND,
    DDV_COMMAND,
    ...RESTORED_COMMANDS,
  ];

  const deadline = Date.now() + REGISTER_BUDGET_MS;

  // Only write what Discord does not already have with these exact fields.
  // Registering is not a change to most commands, and skipping them is what
  // makes a second call finish quickly after a timeout.
  const registered = await fetchRegisteredCommands(url, botToken);
  const unchanged: string[] = [];
  const pendingCommands = commands.filter((command) => {
    if (registered?.has(command.name) && matchesRegistered(command, registered.get(command.name))) {
      unchanged.push(command.name);
      return false;
    }
    return true;
  });

  const results: {
    command: string;
    commandId: string;
    options: string[];
  }[] = [];
  const remaining = pendingCommands.map((command) => command.name);
  // In an object, not a bare `let`: the failure is set inside the workers, and
  // a bare local would be narrowed to null at the reads further down.
  const state: { failure: { command: string; status: number; json: any } | null } = {
    failure: null,
  };

  let next = 0;
  async function worker() {
    while (!state.failure && Date.now() <= deadline) {
      const index = next++;
      if (index >= pendingCommands.length) return;

      const command = pendingCommands[index];
      const outcome = await registerCommand(url, botToken, command, deadline);

      if (outcome.kind === "ok") {
        results.push({
          command: outcome.command,
          commandId: outcome.json.id,
          // Subcommand names for /signups etc., option names for /setup.
          options: (outcome.json.options ?? []).map((o: { name: string }) => o.name),
        });
        const left = remaining.indexOf(outcome.command);
        if (left !== -1) remaining.splice(left, 1);
      } else if (outcome.kind === "failed") {
        console.error("[register-commands] failed:", outcome.command, outcome.status, outcome.json);
        state.failure = { command: outcome.command, status: outcome.status, json: outcome.json };
        return;
      } else {
        // Rate-limited past the budget: leave it in `remaining` for the next call.
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(REGISTER_CONCURRENCY, pendingCommands.length) }, worker)
  );

  const order = new Map(commands.map((command, i) => [command.name, i] as const));
  results.sort((a, b) => (order.get(a.command) ?? 0) - (order.get(b.command) ?? 0));

  return NextResponse.json(
    {
      ok: !state.failure && remaining.length === 0,
      scope: guildId ? `guild ${guildId}` : "global",
      // `commands` are the ones written by this call (with their ids);
      // `unchanged` were already registered exactly like this.
      commands: results,
      ...(unchanged.length ? { unchanged } : {}),
      ...(state.failure
        ? {
            error: "Registration failed",
            command: state.failure.command,
            status: state.failure.status,
            details: state.failure.json,
          }
        : {}),
      ...(remaining.length
        ? {
            pending: remaining,
            retry: "Call this URL again to register the commands still pending.",
          }
        : {}),
    },
    { status: state.failure ? 502 : 200 }
  );
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
