import { NextResponse } from "next/server";
import { NextResponse } from "next/server";

/**
 * One-time-use endpoint to register Discord slash commands.
 * Visit this URL once in a browser to register commands with Discord.
 * DELETE THIS FILE after confirming it worked.
 */
export async function GET() {
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!appId || !token) {
    return NextResponse.json(
      { error: "DISCORD_APP_ID or DISCORD_BOT_TOKEN not set" },
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
          type: 1, // SUB_COMMAND
          name: "report",
          description: "File an incident report",
          options: [
            {
              type: 3, // STRING
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
              type: 6, // USER
              name: "accused",
              description: "Driver the report is against",
              required: false,
            },
            {
              type: 4, // INTEGER
              name: "lap",
              description: "Lap number",
              required: false,
            },
            {
              type: 4,
              name: "round",
              description: "Round number",
              required: false,
            },
            {
              type: 3,
              name: "evidence",
              description: "Link to POV clip / evidence",
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
              type: 3, // STRING
              name: "response",
              description: "Your side of what happened",
              required: true,
            },
            {
              type: 3,
              name: "evidence",
              description: "Link to your own POV clip / evidence",
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
              type: 3, // STRING
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
              type: 4, // INTEGER
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
      ],
    },
    {
      name: "kb",
      description: "Look up league rulebook articles",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "search",
          description: "Search the rulebook",
          options: [
            {
              type: 3, // STRING
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
          type: 1, // SUB_COMMAND
          name: "view",
          description: "View the current roster",
          options: [
            {
              type: 3, // STRING
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
              type: 6, // USER
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
              type: 5, // BOOLEAN
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
      name: "appeal",
      description: "File or review an appeal on a resolved incident",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "file",
          description: "File an appeal on a resolved or dismissed incident",
          options: [
            {
              type: 3, // STRING
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
              type: 3, // STRING
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
              type: 4, // INTEGER
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
      // Discord native KICK_MEMBERS permission bit -- hides this command
      // from the picker for anyone without kick permission in the guild.
      // Narrower than the in-app owner/co-owner check in moderation.ts,
      // which further restricts among members who DO have this permission.
      default_member_permissions: "2",
      dm_permission: false,
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "Member to kick",
          required: true,
        },
        {
          type: 3, // STRING
          name: "reason",
          description: "Reason for the kick",
          required: false,
        },
      ],
    },
    {
      name: "ban",
      description: "Ban a member from the server (owner/co-owner only)",
      // Discord native BAN_MEMBERS permission bit.
      default_member_permissions: "4",
      dm_permission: false,
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "Member to ban",
          required: true,
        },
        {
          type: 3, // STRING
          name: "reason",
          description: "Reason for the ban",
          required: false,
        },
      ],
    },
    {
      name: "lockdown",
      description: "Lock down the server (owner/co-owner only)",
      // Discord native ADMINISTRATOR permission bit -- lockdown is more
      // drastic than kick/ban, so it's gated on the highest native
      // permission tier. Narrower than the in-app owner/co-owner check
      // enforced by pitboss-guardian, which further restricts among
      // members who DO have this permission.
      default_member_permissions: "8",
      dm_permission: false,
      options: [
        {
          type: 3, // STRING
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

/**
 * One-time-use endpoint to register Discord slash commands.
 * Visit this URL once in a browser to register commands with Discord.
 * DELETE THIS FILE after confirming it worked.
 */
export async function GET() {
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!appId || !token) {
    return NextResponse.json(
      { error: "DISCORD_APP_ID or DISCORD_BOT_TOKEN not set" },
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
          type: 1, // SUB_COMMAND
          name: "report",
          description: "File an incident report",
          options: [
            {
              type: 3, // STRING
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
              type: 6, // USER
              name: "accused",
              description: "Driver the report is against",
              required: false,
            },
            {
              type: 4, // INTEGER
              name: "lap",
              description: "Lap number",
              required: false,
            },
            {
              type: 4,
              name: "round",
              description: "Round number",
              required: false,
            },
            {
              type: 3,
              name: "evidence",
              description: "Link to POV clip / evidence",
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
              type: 3, // STRING
              name: "response",
              description: "Your side of what happened",
              required: true,
            },
            {
              type: 3,
              name: "evidence",
              description: "Link to your own POV clip / evidence",
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
              type: 3, // STRING
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
              type: 4, // INTEGER
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
      ],
    },
    {
      name: "kb",
      description: "Look up league rulebook articles",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "search",
          description: "Search the rulebook",
          options: [
            {
              type: 3, // STRING
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
          type: 1, // SUB_COMMAND
          name: "view",
          description: "View the current roster",
          options: [
            {
              type: 3, // STRING
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
              type: 6, // USER
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
              type: 5, // BOOLEAN
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
      name: "appeal",
      description: "File or review an appeal on a resolved incident",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "file",
          description: "File an appeal on a resolved or dismissed incident",
          options: [
            {
              type: 3, // STRING
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
              type: 3, // STRING
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
              type: 4, // INTEGER
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
      // Discord native KICK_MEMBERS permission bit -- hides this command
      // from the picker for anyone without kick permission in the guild.
      // Narrower than the in-app owner/co-owner check in moderation.ts,
      // which further restricts among members who DO have this permission.
      default_member_permissions: "2",
      dm_permission: false,
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "Member to kick",
          required: true,
        },
        {
          type: 3, // STRING
          name: "reason",
          description: "Reason for the kick",
          required: false,
        },
      ],
    },
    {
      name: "ban",
      description: "Ban a member from the server (owner/co-owner only)",
      // Discord native BAN_MEMBERS permission bit.
      default_member_permissions: "4",
      dm_permission: false,
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "Member to ban",
          required: true,
        },
        {
          type: 3, // STRING
          name: "reason",
          description: "Reason for the ban",
          required: false,
        },
      ],
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
