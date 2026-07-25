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
          name: "status
