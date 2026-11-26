// src/app/api/discord/register-commands/route.ts
//
// Registers /setup, /division, /signups (open, resume, status, list, close, invite,
// tracks, test), /signup (photos), /timetrial, /steward and /appeal and /progression with
// Discord. Each command is POSTed BY NAME, which overwrites that one command
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
        { type: 7, name: "incident_channel", description: "This division's incident reports channel", channel_types: [0], required: false },
        { type: 7, name: "transcript_channel", description: "This division's ticket transcripts channel", channel_types: [0], required: false },
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
    SIGN_DRIVER_COMMAND,
    RELEASE_DRIVER_COMMAND,
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
    ...RESTORED_COMMANDS,
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
