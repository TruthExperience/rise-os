import { NextRequest, NextResponse } from "next/server";
import { InteractionType, InteractionResponseType } from "discord-interactions";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import { routeCommand } from "@/lib/discord/commands/router";
import { routeComponent } from "@/lib/discord/components/router";

/**
 * Single entry point for every Discord slash command / component
 * interaction across all leagues. Discord POSTs here for every
 * interaction in any guild where this app is installed.
 *
 * Required Discord Developer Portal config:
 *   Interactions Endpoint URL -> https://<your-domain>/api/discord/interactions
 *
 * Required env vars:
 *   PITBOSS_DISCORD_PUBLIC_KEY
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

  if (interaction.type === InteractionType.PING) {
    return NextResponse.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const response = await routeCommand(interaction);
    return NextResponse.json(response);
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const response = await routeComponent(interaction);
    return NextResponse.json(response);
  }

  return new NextResponse("Unhandled interaction type", { status: 400 });
}
