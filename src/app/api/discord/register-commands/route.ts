import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * One-time-use endpoint to register Discord slash commands.
 * Protected by REGISTER_COMMANDS_SECRET — pass it as ?secret=... in the URL.
 * DELETE THIS FILE after confirming it worked.
 *
 * NOTE: this does a bulk PUT, which REPLACES every global command with the
 * list below. Any command missing from this list gets removed from Discord.
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
      name: "division",
      description: "Manage league divisions (owner/co-owner/commissioner)",
      options: [
        {
          type: 1,
          name: "create",
          description: "Create a division with its Discord role and check-in channel",
          options: [
            {
              type: 3,
              name: "code",
              description: "Short code, e.g. D1 or F2",
              required: true,
            },
            {
              type: 3,
              name: "name",
              description: "Display name (defaults to the code)",
              required: false,
            },
            {
              type: 4,
              name: "max_drivers",
              description: "Maximum drivers in this division",
              required: false,
              min_value: 1,
            },
            {
              type: 4,
              name: "tier_order",
              description: "Sort order, 1 = top division",
              required: false,
              min_value: 1,
            },
            {
              type: 5,
              name: "create_discord",
              description: "Create role, category and check-in channel (default: yes)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List this league's divisions",
        },
        {
          type: 1,
          name: "assign",
          description: "Put a driver in a division (moves them if already in another)",
          options: [
            {
              type: 6,
              name: "driver",
              description: "The driver",
              required: true,
            },
            {
              type: 3,
              name: "division",
              description: "Division code, e.g. D1",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "remove",
          description: "Take a driver out of their division",
          options: [
            {
              type: 6,
              name: "driver",
              description: "The driver",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "link",
          description: "Attach a channel or role to an existing division, or edit its cap or name",
          options: [
            {
              type: 3,
              name: "code",
              description: "Division code, e.g. F2",
              required: true,
            },
            {
              type: 7,
              name: "checkin_channel",
              description: "Check-in channel for this division",
              required: false,
              channel_types: [0],
            },
            {
              type: 8,
              name: "role",
              description: "Discord role for this division",
              required: false,
            },
            {
              type: 4,
              name: "max_drivers",
              description: "Maximum drivers",
              required: false,
              min_value: 1,
            },
            {
              type: 3,
              name: "name",
              description: "Display name",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "delete",
          description: "Delete a division (blocked if it has rounds or check-ins)",
          options: [
            {
              type: 3,
              name: "code",
              description: "Division code, e.g. D2",
              required: true,
            },
            {
              type: 5,
              name: "delete_discord",
              description: "Also delete its Discord role, category and channel (default: no)",
              required: false,
            },
          ],
        },
      ],
    },
    {
      // Season signups (owner/co-owner/commissioner). Dispatches to
      // signups_open / signups_resume / signups_status / signups_close in
      // src/lib/discord/commands/signups.ts.
      name: "signups",
      description: "Season signups: DM league members to sign up (owner/co-owner/commissioner)",
      dm_permission: false,
      options: [
        {
          type: 1,
          name: "open",
          description: "Open season signups and DM every league member",
          options: [
            {
              type: 4,
              name: "season",
              description: "Season number (defaults to the league's upcoming season)",
              required: false,
              min_value: 1,
            },
            {
              type: 3,
              name: "message",
              description: "Custom DM text (defaults to a standard signup message)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "resume",
          description: "Keep sending signup DMs that are still queued",
        },
        {
          type: 1,
          name: "status",
          description: "Show signup counts for the open round",
        },
        {
          type: 1,
          name: "list",
          description: "See who signed up, declined, or hasn't answered yet",
          options: [
            {
              type: 3,
              name: "show",
              description: "Which members to list (default: signed up)",
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
      ],
    },
    {
      // Syncs the Discord server's members into PitBoss (pitboss.drivers +
      // pitboss.driver_leagues) so /signups open can see them. Dispatches
      // to "members-sync" in src/lib/discord/commands/members-sync.ts.
      // No default_member_permissions on purpose: the handler checks league
      // owner flags OR Discord Administrator / Manage Server itself, so
      // owners who aren't server admins can still run it.
      name: "members-sync",
      description: "Add this server's Discord members to the league (owner / server admin)",
      dm_permission: false,
      options: [
        {
          type: 8,
          name: "role",
          description: "Only sync members with this role (use for a small test group)",
          required: false,
        },
        {
          type: 5,
          name: "apply",
          description: "Actually add them (default: preview only, nothing is written)",
          required: false,
        },
      ],
    },
    {
      // Discord role -> PitBoss permission flag mapping. Dispatches to
      // roles_map / roles_unmap / roles_list / roles_sync in
      // src/lib/discord/commands/roles.ts. No default_member_permissions:
      // the handler allows owner/co-owner/commissioner flags OR Discord
      // Administrator itself.
      name: "roles",
      description: "Map Discord roles to PitBoss permissions and sync them (owner/co-owner/commissioner/admin)",
      dm_permission: false,
      options: [
        {
          type: 1,
          name: "map",
          description: "Link a Discord role to a PitBoss permission",
          options: [
            {
              type: 8,
              name: "role",
              description: "The Discord role",
              required: true,
            },
            {
              type: 3,
              name: "flag",
              description: "The permission this role grants",
              required: true,
              choices: [
                { name: "Co-owner", value: "is_co_owner" },
                { name: "Commissioner", value: "is_commissioner" },
                { name: "Head steward", value: "is_head_steward" },
                { name: "Steward", value: "is_steward" },
                { name: "BSAC chief", value: "is_bsac_chief" },
                { name: "Team principal", value: "is_team_principal" },
                { name: "Driver", value: "is_driver" },
              ],
            },
          ],
        },
        {
          type: 1,
          name: "unmap",
          description: "Remove a role's link to a permission",
          options: [
            {
              type: 8,
              name: "role",
              description: "The Discord role",
              required: true,
            },
            {
              type: 3,
              name: "flag",
              description: "Only remove this permission (omit to remove all for the role)",
              required: false,
              choices: [
                { name: "Co-owner", value: "is_co_owner" },
                { name: "Commissioner", value: "is_commissioner" },
                { name: "Head steward", value: "is_head_steward" },
                { name: "Steward", value: "is_steward" },
                { name: "BSAC chief", value: "is_bsac_chief" },
                { name: "Team principal", value: "is_team_principal" },
                { name: "Driver", value: "is_driver" },
              ],
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "Show which roles are mapped to which permissions",
        },
        {
          type: 1,
          name: "sync",
          description: "Set members' permissions from their Discord roles (preview unless apply is on)",
          options: [
            {
              type: 5,
              name: "apply",
              description: "Actually write the changes (default: preview only, nothing is written)",
              required: false,
            },
          ],
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
      // Season calendar admin (owner/co-owner/commissioner). Dispatches to
      // calendar_add / calendar_import / calendar_list / calendar_remove in
      // src/lib/discord/commands/season-admin.ts.
      name: "calendar",
      description: "Set up a season's race calendar (owner/co-owner/commissioner)",
      dm_permission: false,
      options: [
        {
          type: 1,
          name: "add",
          description: "Add or update one round on the calendar",
          options: [
            {
              type: 4,
              name: "season",
              description: "Season number",
              required: true,
              min_value: 1,
            },
            {
              type: 4,
              name: "round",
              description: "Round number",
              required: true,
              min_value: 1,
            },
            {
              type: 3,
              name: "name",
              description: "Round name, e.g. Australia Grand Prix",
              required: true,
            },
            {
              type: 3,
              name: "date",
              description: "Race date, YYYY-MM-DD (e.g. 2026-09-06)",
              required: false,
            },
            {
              type: 3,
              name: "circuit",
              description: "Circuit name",
              required: false,
            },
            {
              type: 3,
              name: "country",
              description: "Country",
              required: false,
            },
            {
              type: 3,
              name: "flag",
              description: "Flag emoji (e.g. 🇦🇺) — needed for the flag image on check-in cards",
              required: false,
            },
            {
              type: 3,
              name: "division",
              description: "Division code (omit for a league-wide round)",
              required: false,
            },
            {
              type: 5,
              name: "sprint",
              description: "Sprint weekend?",
              required: false,
            },
            {
              type: 3,
              name: "type",
              description: "Round type (default: race)",
              required: false,
              choices: [
                { name: "Race", value: "race" },
                { name: "Break", value: "break" },
                { name: "Testing", value: "testing" },
              ],
            },
          ],
        },
        {
          type: 1,
          name: "import",
          description: "Load a whole season calendar from a CSV file",
          options: [
            {
              type: 11,
              name: "file",
              description: "CSV with columns: round, name, circuit, country, flag, date, sprint, type",
              required: true,
            },
            {
              type: 4,
              name: "season",
              description: "Season number",
              required: true,
              min_value: 1,
            },
            {
              type: 3,
              name: "division",
              description: "Division code (omit for league-wide rounds)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "Show a season's calendar",
          options: [
            {
              type: 4,
              name: "season",
              description: "Season number (defaults to the latest)",
              required: false,
              min_value: 1,
            },
            {
              type: 3,
              name: "division",
              description: "Only show this division",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "remove",
          description: "Remove a round from the calendar (blocked if it has results)",
          options: [
            {
              type: 4,
              name: "season",
              description: "Season number",
              required: true,
              min_value: 1,
            },
            {
              type: 4,
              name: "round",
              description: "Round number",
              required: true,
              min_value: 1,
            },
            {
              type: 3,
              name: "division",
              description: "Division code (omit for a league-wide round)",
              required: false,
            },
            {
              type: 3,
              name: "type",
              description: "Round type (default: race)",
              required: false,
              choices: [
                { name: "Race", value: "race" },
                { name: "Break", value: "break" },
                { name: "Testing", value: "testing" },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "set-result",
      description: "Enter one driver's result for a race (owner/co-owner/commissioner)",
      dm_permission: false,
      options: [
        {
          type: 6,
          name: "driver",
          description: "Driver",
          required: true,
        },
        {
          type: 4,
          name: "season",
          description: "Season number",
          required: true,
          min_value: 1,
        },
        {
          type: 3,
          name: "round",
          description: "Round number or name",
          required: true,
        },
        {
          type: 4,
          name: "finish",
          description: "Finishing position (not needed if DNF)",
          required: false,
          min_value: 1,
        },
        {
          type: 4,
          name: "quali",
          description: "Qualifying position",
          required: false,
          min_value: 1,
        },
        {
          type: 5,
          name: "dnf",
          description: "Did not finish?",
          required: false,
        },
        {
          type: 5,
          name: "fastest_lap",
          description: "Set the fastest lap?",
          required: false,
        },
        {
          type: 10,
          name: "points",
          description: "Points override (defaults to the league's points table)",
          required: false,
        },
        {
          type: 4,
          name: "sprint_finish",
          description: "Sprint finishing position",
          required: false,
          min_value: 1,
        },
        {
          type: 3,
          name: "dnf_reason",
          description: "Reason for the DNF",
          required: false,
        },
        {
          type: 3,
          name: "division",
          description: "Division code (needed if the round exists in more than one division)",
          required: false,
        },
      ],
    },
    {
      name: "import-results",
      description: "Load a whole race's results from a CSV file (owner/co-owner/commissioner)",
      dm_permission: false,
      options: [
        {
          type: 11,
          name: "file",
          description: "CSV with columns: driver, finish, quali, dnf, dnf_reason, fastest_lap, points, sprint_finish",
          required: true,
        },
        {
          type: 4,
          name: "season",
          description: "Season number",
          required: true,
          min_value: 1,
        },
        {
          type: 3,
          name: "round",
          description: "Round number or name",
          required: true,
        },
        {
          type: 3,
          name: "division",
          description: "Division code (needed if the round exists in more than one division)",
          required: false,
        },
      ],
    },
    {
      name: "set-standings",
      description: "Set a driver's total season points (owner/co-owner/commissioner)",
      dm_permission: false,
      options: [
        {
          type: 6,
          name: "driver",
          description: "Driver",
          required: true,
        },
        {
          type: 4,
          name: "season",
          description: "Season number",
          required: true,
          min_value: 1,
        },
        {
          type: 10,
          name: "points",
          description: "Their total points for the season",
          required: true,
        },
        {
          type: 3,
          name: "reason",
          description: "Why (saved with the adjustment)",
          required: false,
        },
      ],
    },
    {
      name: "results",
      description: "View the results for a race round (defaults to the most recent round with results)",
      options: [
        {
          type: 3,
          name: "round",
          description: "Round number or name (defaults to the most recent round with results)",
          required: false,
        },
        {
          type: 3,
          name: "season",
          description: "Season (defaults to the most recent season with recorded results)",
          required: false,
        },
      ],
    },
    {
      name: "standings",
      description: "View the driver standings leaderboard",
      options: [
        {
          type: 3,
          name: "season",
          description: "Season code (defaults to the most recent season with recorded results)",
          required: false,
        },
        {
          type: 4,
          name: "limit",
          description: "How many drivers to show (default 15, max 25)",
          required: false,
        },
      ],
    },
    {
      name: "exam",
      description: "Get the link to take a certification exam",
    },
    {
      name: "cert",
      description: "View your active certifications in this league",
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
      // /setup: every option is now optional. Anything left out is
      // auto-detected from the server's channels and roles (see
      // src/lib/discord/commands/setup.ts), and anything you pick
      // overrides the auto-detected value.
      name: "setup",
      description: "Set up this server as a PitBoss league — reads your channels automatically (admin only)",
      default_member_permissions: "8",
      dm_permission: false,
      options: [
        {
          type: 3,
          name: "name",
          description: "League name (defaults to the server name)",
          required: false,
        },
        {
          type: 7,
          name: "fia_category",
          description: "Category for FIA / race-control tickets (auto-detected if left out)",
          required: false,
          channel_types: [4],
        },
        {
          type: 7,
          name: "reports_channel",
          description: "Text channel for incident reports (auto-detected if left out)",
          required: false,
          channel_types: [0],
        },
        {
          type: 7,
          name: "transcript_channel",
          description: "Text channel for ticket transcripts (auto-detected if left out)",
          required: false,
          channel_types: [0],
        },
        {
          type: 7,
          name: "appeals_channel",
          description: "Text channel for appeals (auto-detected if left out)",
          required: false,
          channel_types: [0],
        },
        {
          type: 8,
          name: "steward_role",
          description: "Steward role (auto-detected if left out)",
          required: false,
        },
        {
          type: 5,
          name: "financial_system",
          description: "Does this league use a salary cap / financial system?",
          required: false,
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
