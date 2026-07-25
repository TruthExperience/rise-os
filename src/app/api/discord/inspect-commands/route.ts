import { NextResponse } from "next/server";

/**
 * Read-only diagnostic: shows the commands currently registered
 * with Discord, so we can see the exact structure of /steward
 * before adding new subcommands. DELETE after use.
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

  const res = await fetch(
    `https://discord.com/api/v10/applications/${appId}/commands`,
    { headers: { Authorization: `Bot ${token}` } }
  );

  const body = await res.json();
  return NextResponse.json({ status: res.status, body }, { status: res.ok ? 200 : 502 });
}
