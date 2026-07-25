import { NextRequest, NextResponse } from "next/server";
import { InteractionType, InteractionResponseType } from "discord-interactions";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import { routeCommand } from "@/lib/discord/commands/router";

/**
 * Single entry point for every Discord slash command / component
 * interaction across all leagues. Discord POSTs here for every
 * interaction in any guild where this app is installed.
 *
 * Required Discord Developer Portal config:
 *   Interactions Endpoint URL -> https://<your-domain>/api/discord/interactions
 *
 * Required env vars:
 *   DISCORD_PUBLIC_KEY
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");

  const isValid = await verifyDiscordRequest(rawBody, signature, timestamp);
  if (!isValid) {
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // Discord's handshake check — must respond with PONG or the
  // endpoint gets marked invalid and Discord stops sending traffic.
  if (interaction.type === InteractionType.PING) {
    return NextResponse.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const response = await routeCommand(interaction);
    return NextResponse.json(response);
  }

  // Buttons/modals/select menus land here in later phases
  // (cert exam flow, roster confirmation prompts, etc.)
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    return NextResponse.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Component interactions aren't wired up yet.", flags: 64 },
    });
  }

  return new NextResponse("Unhandled interaction type", { status: 400 });
}
