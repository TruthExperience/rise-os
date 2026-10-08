// src/lib/getSupabaseUserId.ts
//
// This file used to hold a second, byte-for-byte copy of the helpers that
// live in src/lib/supabase/server.ts. They are now defined once there and
// re-exported here, so existing imports from "@/lib/getSupabaseUserId" keep
// working unchanged.
export { getSupabaseUserId, getAuthedDriver } from "@/lib/supabase/server";
