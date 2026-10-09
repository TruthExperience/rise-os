// src/lib/leagueAdmin.ts
//
// Shared "can this person administer this league?" check for rise_os API
// routes. Same two-step rule as src/app/api/league/[id]/rules/route.ts:
// a rise_os.league_admins row, or an active league_members row whose
// role is in the admin tier. 'owner' is included up front (the rules
// route originally left it out and locked owners out of their own league).
//
// Server-only.

import { createClient } from "@supabase/supabase-js";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";

const ADMIN_ROLES = ["owner", "commissioner", "co_commissioner", "admin"];

export type LeagueAccess = {
  /** public.users.id of the signed-in user, or null when signed out. */
  userId: string | null;
  isAdmin: boolean;
};

export async function getLeagueAccess(leagueId: string): Promise<LeagueAccess> {
  const userId = await getSupabaseUserId();
  if (!userId) return { userId: null, isAdmin: false };

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: "rise_os" } }
  );

  const { data: adminRow } = await db
    .from("league_admins")
    .select("role")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .maybeSingle();
  if (adminRow) return { userId, isAdmin: true };

  const { data: memberRow } = await db
    .from("league_members")
    .select("role, status")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  return { userId, isAdmin: !!memberRow && ADMIN_ROLES.includes(memberRow.role) };
}
