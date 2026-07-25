import { NextResponse } from "next/server";

/**
 * One-time-use endpoint to register Discord slash commands.
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
          type: 1,
          name: "view",
          description: "View the current roster",
          options: [
            { type: 3, name: "tier", description: "Filter by tier", choices: tierChoices },
          ],
        },
        {
          type: 1,
          name: "assign",
          description: "Assign a driver to a team",
          options: [
            { type: 6, name: "driver", description: "Driver to assign", required: true },
            { type: 3, name: "team", description: "Team", required: true, choices: teamChoices },
            { type: 3, name: "tier", description: "Tier", required: true, choices: tierChoices },
            { type: 5, name: "principal", description: "Assign as Team Principal?" },
            { type: 3, name: "season", description: "Season code (defaults to S2)" },
          ],
        },
        {
          type: 1,
          name: "remove",
          description: "Remove a driver from the roster",
          options: [
            { type: 6, name: "driver", description: "Driver to remove", required: true },
            { type: 3, name: "season", description: "Season code (defaults to S2)" },
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
            { type: 3, name: "query", description: "What to search for", required: true },
          ],
        },
      ],
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
            { type: 3, name: "type", description: "Incident type (e.g. Collision / Contact, Track Limits)", required: true },
            { type: 3, name: "description", description: "What happened", required: true },
            { type: 6, name: "accused", description: "Driver the report is against" },
            { type: 4, name: "lap", description: "Lap number" },
            { type: 4, name: "round", description: "Round number" },
            { type: 3, name: "evidence", description: "Link to POV clip / evidence" },
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
            { type: 3, name: "response", description: "Your side of what happened", required: true },
            { type: 3, name: "evidence", description: "Link to your own POV clip / evidence" },
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
          description: "Submit the final ruling on this incident (run inside the ticket)",
          options: [
            { type: 3, name: "verdict", description: "The verdict (e.g. Guilty, No Further Action)", required: true },
            { type: 3, name: "penalty", description: "Penalty description (e.g. 5s time penalty)" },
            { type: 4, name: "points", description: "Penalty points to add to the driver's ledger" },
            { type: 3, name: "notes", description: "Steward notes" },
            { type: 3, name: "override_reason", description: "Reason for overriding the AI suggestion, if applicable" },
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
