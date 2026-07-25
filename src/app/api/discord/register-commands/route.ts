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
