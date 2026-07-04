import { createClient } from "@supabase/supabase-js";

// Server-only client. Uses the service role key so it can call the
// SECURITY DEFINER join_league() functions, which are granted to
// `service_role` (rise-os doesn't use Supabase Auth, so there's no
// per-request user JWT to rely on — auth is handled by NextAuth instead).
//
// NEVER import this file into a "use client" component.
export const supabaseServer = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
