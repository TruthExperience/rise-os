import { verifyKey } from "discord-interactions";

/**
 * Verifies an incoming Discord interaction request using the app's
 * public key (Ed25519). Discord signs every request; requests that
 * fail verification must be rejected with 401 or Discord will
 * disable the endpoint.
 *
 * Env var required: PITBOSS_DISCORD_PUBLIC_KEY
 */
export async function verifyDiscordRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null
): Promise<boolean> {
  if (!signature || !timestamp) return false;

  const publicKey = process.env.PITBOSS_DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    throw new Error("PITBOSS_DISCORD_PUBLIC_KEY is not set");
  }

  return verifyKey(rawBody, signature, timestamp, publicKey);
}
