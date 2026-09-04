import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

export type AuthedDriver = {
  id: string;
  user_id: string;
  discord_id: string | null;
  discord_username: string | null;
  discord_avatar: string | null;
  display_name: string | null;
  [key: string]: unknown;
};

/**
 * Resolves the current request's session to a pitboss.drivers row.
 *
 * Linkage: auth session -> claims.sub -> public.users.auth_user_id -> public.users.id
 *          -> pitboss.drivers.user_id
 *
 * Returns null if there is no session, no linked public.users row, or no
 * pitboss.drivers row yet (e.g. before the row has been created via POST).
 */
export async function getAuthedDriver(): Promise<AuthedDriver | null> {
  const supabase = await createServerClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  const authUserId = claims?.claims?.sub;

  if (claimsError || !authUserId) {
    return null;
  }

  const admin = createAdminClient();

  const { data: userRow, error: userError } = await admin
    .from("users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (userError || !userRow) {
    return null;
  }

  const { data: driverRow, error: driverError } = await admin
    .schema("pitboss")
    .from("drivers")
    .select()
    .eq("user_id", userRow.id)
    .maybeSingle();

  if (driverError || !driverRow) {
    return null;
  }

  return driverRow as AuthedDriver;
}
