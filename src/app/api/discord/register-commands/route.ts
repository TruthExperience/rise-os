import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * One-time-use endpoint to register Discord slash commands.
 * Protected by REGISTER_COMMANDS_SECRET — pass it as ?secret=... in the URL.
 * DELETE THIS FILE after confirming it worked.
 */
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const expected = process.env.REGISTER_COMMANDS_SECRET;

  if (!expected) {
    return NextResponse.json(
      { error: "REGISTER_COMMANDS_SECRET not set" },
      { status: 500 }
    );
  }

  if (secret !== expected) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const appId = process.env.PITBOSS_DISCORD_APPLICATION_ID;
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;

  if (!appId || !token) {
    return NextResponse.json(
      { error: "PITBOSS_DISCORD_APPLICATION_ID or PITBOSS_DISCORD_BOT_TOKEN not set" },
      { status: 500 }
    );
  }

  const teamChoices = [
    "Alpine",
    "Aston Martin",
    "Audi",
    "Cadillac",
    "Ferrari",
    "Haas",
    "Kick Sauber",
    "McLaren",
    "Mercedes",
    "Racing Bulls",
    "Red Bull Racing",
    "Williams",
  ].map((name) => ({ name, value: name }));

  const tierChoices = [
    { name: "Tier 1", value: "Tier 1" },
    { name: "Tier 2", value: "Tier 2" },
  ];

  // Extended to match round_checkins.status CHECK, which now also allows
  // 'healer' (D2 drivers / D1 reserves / team principals) and 'damage'
  // (commentator-only) alongside the original three.
  const checkinStatusChoices = [
    { name: "Confirmed", value: "confirmed" },
    { name: "Tentative", value: "tentative" },
    { name: "Declined", value: "declined" },
    { name: "Healer (D2 / reserve / TP)", value: "healer" },
    { name: "Damage (commentator)", value: "damage" },
  ];

  const commands = [
    {
      name: "ping",
      description: "Check that the PitBoss bot is alive for this league",
    },
    {
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
              description:
                "Link to POV clip / evidence (optional if attaching a file below — at least one of the two is required)",
              required: false,
            },
            {
              type: 11,
              name: "evidence_file",
              description:
                "Upload a POV clip, screenshot, or telemetry file directly (optional if a link is provided above — at least one of the two is required)",
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
              description: "Link to your own POV clip / evidence (optional; you can also attach a file below)",
              required: false,
            },
            {
              type: 11,
              name: "evidence_file",
              description: "Upload your own POV clip or screenshot directly (optional; you can also paste a link above)",
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
    },
    {
      name: "cap",
      description: "View salary cap usage for a franchise or division",
      options: [
        {
          type: 1,
          name: "view",
          description: "View salary cap usage for a franchise (defaults to your own)",
          options: [
            {
              type: 3,
              name: "franchise",
              description: "Franchise name or abbreviation (defaults to your own franchise)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "edit",
          description: "Set a franchise's salary cap (league owner/co-owner only)",
          options: [
            {
              type: 3,
              name: "franchise",
              description: "Franchise name or abbreviation",
              required: true,
            },
            {
              type: 10,
              name: "amount",
              description: "New salary cap amount",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "board",
          description: "View salary cap usage across a division (or the whole league)",
          options: [
            {
              type: 3,
              name: "season",
              description: "Season — shows only that season's teams",
              required: false,
              choices: [
                { name: "2025", value: "25" },
                { name: "2026", value: "26" },
              ],
            },
            {
              type: 3,
              name: "division",
              description: "Division/car-class filter (e.g. F1_26) — omit to show everything. Ignored if season is set.",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "league",
          description: "View a league-wide salary cap summary, broken down by division",
        },
      ],
    },
    {
      name: "ddv",
      description: "View or adjust a driver's Dynamic Driver Value",
      options: [
        {
          type: 1,
          name: "view",
          description: "View a driver's DDV (defaults to yourself)",
          options: [
            {
              type: 6,
              name: "driver",
              description: "Driver to look up (defaults to yourself)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "edit",
          description: "Manually set a driver's DDV (league owner/co-owner only)",
          options: [
            {
              type: 6,
              name: "driver",
              description: "Driver to adjust",
              required: true,
            },
            {
              type: 10,
              name: "ddv",
              description: "New DDV amount",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Reason for the manual adjustment",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "leaderboard",
          description: "View the league's DDV leaderboard, ranked by current DDV",
        },
        {
          type: 1,
          name: "team",
          description: "View a team's full DDV roster (defaults to your own team, if you're a TP)",
          options: [
            {
              type: 3,
              name: "team",
              description: "Team name (defaults to your own team as Team Principal)",
              required: false,
            },
            {
              type: 3,
              name: "season",
              description: "Season code (defaults to the league's current season)",
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: "tp",
      description: "View Team Principal assignments",
      options: [
        {
          type: 1,
          name: "view",
          description: "View a team's Team Principal, or list every team's TP",
          options: [
            {
              type: 3,
              name: "team",
              description: "Team name (omit to list every team's TP)",
              required: false,
            },
            {
              type: 3,
              name: "season",
              description: "Season code (defaults to the league's current season)",
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: "kb",
      description: "Look up league rulebook articles",
      options: [
        {
          type: 1,
          name: "search",
          description: "Search the rulebook",
          options: [
            {
              type: 3,
              name: "query",
              description: "What to search for",
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: "roster",
      description: "Manage league team rosters",
      options: [
        {
          type: 1,
          name: "view",
          description: "View the current roster",
          options: [
            {
              type: 3,
              name: "tier",
              description: "Filter by tier",
              required: false,
              choices: tierChoices,
            },
          ],
        },
        {
          type: 1,
          name: "assign",
          description: "Assign a driver to a team",
          options: [
            {
              type: 6,
              name: "driver",
              description: "Driver to assign",
              required: true,
            },
            {
              type: 3,
              name: "team",
              description: "Team",
              required: true,
              choices: teamChoices,
            },
            {
              type: 3,
              name: "tier",
              description: "Tier",
              required: true,
              choices: tierChoices,
            },
            {
              type: 5,
              name: "principal",
              description: "Assign as Team Principal?",
              required: false,
            },
            {
              type: 3,
              name: "season",
              description: "Season code (defaults to S2)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "remove",
          description: "Remove a driver from the roster",
          options: [
            {
              type: 6,
              name: "driver",
              description: "Driver to remove",
              required: true,
            },
            {
              type: 3,
              name: "season",
              description: "Season code (defaults to S2)",
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: "contract",
      description: "View driver contract details",
      options: [
        {
          type: 1,
          name: "view",
          description: "View a driver's contract details",
          options: [
            {
              type: 6,
              name: "driver",
              description: "Driver to look up (defaults to yourself)",
              required: false,
            },
            {
              type: 3,
              name: "season",
              description: "Season (defaults to current)",
              required: false,
            },
          ],
        },
      ],
    },
    {
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
      ],
    },
    {
      name: "release-driver",
      description: "Release a driver from their current franchise",
      options: [
        {
          type: 6,
          name: "driver",
          description: "Driver to release",
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
          name: "reason",
          description: "Reason for release",
          required: false,
        },
      ],
    },
    {
      name: "checkin",
      description: "Check in (or out) for an upcoming race",
      options: [
        {
          type: 3,
          name: "status",
          description: "Your attendance status",
          required: true,
          choices: checkinStatusChoices,
        },
        {
          type: 3,
          name: "round",
          description: "Round number or name (defaults to the next scheduled race)",
          required: false,
        },
        {
          type: 3,
          name: "season",
          description: "Season number (defaults to the round's season)",
          required: false,
        },
      ],
    },
    {
      name: "checkin-status",
      description: "View check-in status for a race round (stewards/admins)",
      options: [
        {
          type: 3,
          name: "round",
          description: "Round number or name (defaults to the next scheduled race)",
          required: false,
        },
        {
          type: 3,
          name: "season",
          description: "Season number (defaults to the round's season)",
          required: false,
        },
      ],
    },
    {
      name: "checkin-remind",
      description: "Ping everyone who hasn't checked in for a race round",
      options: [
        {
          type: 3,
          name: "round",
          description: "Round number or name (defaults to the next scheduled race)",
          required: false,
        },
        {
          type: 3,
          name: "season",
          description: "Season number (defaults to the round's season)",
          required: false,
        },
      ],
    },
    {
      name: "checkin-create",
      description: "Post the race check-in card (track/weather/countdown + buttons) to a division's channel",
      options: [
        {
          type: 3,
          name: "division",
          description: "Division code (e.g. D1, D2)",
          required: true,
        },
        {
          type: 3,
          name: "round",
          description: "Round number or name (defaults to the next scheduled race)",
          required: false,
        },
        {
          type: 3,
          name: "season",
          description: "Season number (defaults to the round's season)",
          required: false,
        },
        {
          type: 3,
          name: "weather",
          description: "Weather description (e.g. '16°C, Clouds')",
          required: false,
        },
        {
          type: 3,
          name: "ping_delivery",
          description: "How pings are delivered for this race (e.g. 'Channel only', 'Role ping')",
          required: false,
        },
        {
          type: 3,
          name: "race_time",
          description: "Race start time, ISO 8601 (e.g. 2026-09-06T15:00:00Z) — defaults to the round's date at 15:00 UTC",
          required: false,
        },
        {
          type: 3,
          name: "track",
          description: "Manual track/circuit override — use if the calendar's track is missing or wrong for this round",
          required: false,
        },
        {
          type: 3,
          name: "country",
          description: "Manual country override (pairs with track)",
          required: false,
        },
        {
          type: 3,
          name: "flag",
          description: "Manual flag emoji override (e.g. 🇯🇵) — needed for the flag image to render with a manual track",
          required: false,
        },
      ],
    },
    {
      name: "generate-grid",
      description: "Build the team lineup grid from confirmed check-ins",
      options: [
        {
          type: 3,
          name: "round",
          description: "Round number or name (defaults to the next scheduled race)",
          required: false,
        },
        {
          type: 3,
          name: "season",
          description: "Season number (defaults to the round's season)",
          required: false,
        },
        {
          type: 5,
          name: "regenerate",
          description: "Rebuild an existing grid for this round",
          required: false,
        },
      ],
    },
    {
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
              description: "Incident short ID",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Why you're appealing this incident",
              required: true,
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
              type: 3,
              name: "notes",
              description: "Steward notes on the decision",
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: "kick",
      description: "Kick a member from the server (owner/co-owner only)",
      default_member_permissions: "2",
      dm_permission: false,
      options: [
        {
          type: 6,
          name: "user",
          description: "Member to kick",
          required: true,
        },
        {
          type: 3,
          name: "reason",
          description: "Reason for the kick",
          required: false,
        },
      ],
    },
    {
      name: "ban",
      description: "Ban a member from the server (owner/co-owner only)",
      default_member_permissions: "4",
      dm_permission: false,
      options: [
        {
          type: 6,
          name: "user",
          description: "Member to ban",
          required: true,
        },
        {
          type: 3,
          name: "reason",
          description: "Reason for the ban",
          required: false,
        },
      ],
    },
    {
      name: "lockdown",
      description: "Lock down the server (owner/co-owner only)",
      default_member_permissions: "8",
      dm_permission: false,
      options: [
        {
          type: 3,
          name: "reason",
          description: "Reason for the lockdown",
          required: false,
        },
      ],
    },
    {
      name: "endlockdown",
      description: "Lift an active server lockdown (owner/co-owner only)",
      default_member_permissions: "8",
      dm_permission: false,
    },
  ];

  const res = await fetch(
    `https://discord.com/api/v10/applications/${appId}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    }
  );

  const body = await res.json();

  return NextResponse.json(
    { status: res.status, ok: res.ok, body },
    { status: res.ok ? 200 : 502 }
  );
}
