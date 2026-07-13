// src/lib/pitboss/resolveDriver.ts
//
// next-auth is configured with strategy: 'jwt' and no database adapter, so
// session.user.id === token.sub, which is seeded from the Discord profile's
// `id` on first sign-in (see authOptions jwt callback). It is a Discord
// snowflake string, NOT a public.users.id or pitboss.drivers.id UUID.
//
// The reliable join is:
//   session.user.id (discord snowflake)
//     === public.users.discord_id
//     === pitboss.drivers.discord_id
//
// Use this helper anywhere you need a pitboss.drivers.id from a session,
// instead of comparing session.user.id directly against a drivers.id.

import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Resolve a pitboss.drivers.id from a Discord snowflake (session.user.discordId
 * or session.user.id — they're the same value).
 *
 * Returns null if there's no discordId, no matching driver row, or a query error.
 */
export async function resolveDriverIdFromSession(
  discordId: string | undefined | null
): Promise<string | null> {
  if (!discordId) return null

  const { data, error } = await supabaseAdmin
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (error) {
    console.error('resolveDriverIdFromSession: supabase error', error.message)
    return null
  }

  return data?.id ?? null
}

/**
 * Resolve a full pitboss.drivers row from a Discord snowflake.
 * Use when you need more than just the id (e.g. tier, display_name) right
 * after resolving, to avoid a second round trip.
 */
export async function resolveDriverFromSession(
  discordId: string | undefined | null
) {
  if (!discordId) return null

  const { data, error } = await supabaseAdmin
    .schema('pitboss')
    .from('drivers')
    .select('*')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (error) {
    console.error('resolveDriverFromSession: supabase error', error.message)
    return null
  }

  return data
}
