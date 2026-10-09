import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";

export const dynamic = "force-dynamic";

// Lazy singleton — constructed on first use inside a handler, not at
// module load. Avoids "supabaseUrl is required" during Next.js's
// build-time page-data collection. Untyped deliberately: SupabaseClient's
// schema generic defaults to "public", which would reject the rise_os-scoped
// client at compile time if annotated explicitly.
let _supabaseAdmin: any = null;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: "rise_os" } }
    );
  }
  return _supabaseAdmin;
}

// Same two-step check as src/app/api/league/[id]/rules/route.ts:
// a rise_os.league_admins row, or an active league_members row whose role
// is in the admin tier. 'owner' is included up front (the rules route
// originally left it out and locked owners out of their own league).
const ADMIN_ROLES = ["owner", "commissioner", "co_commissioner", "admin"];

// Returns null when the caller may edit this league, otherwise the
// error response to send back.
async function requireLeagueAdmin(leagueId: string): Promise<NextResponse | null> {
  const userId = await getSupabaseUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const db = getSupabaseAdmin();

  const { data: adminRow } = await db
    .from("league_admins")
    .select("role")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .maybeSingle();
  if (adminRow) return null;

  const { data: memberRow } = await db
    .from("league_members")
    .select("role, status")
    .eq("league_id", leagueId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (memberRow && ADMIN_ROLES.includes(memberRow.role)) return null;

  return NextResponse.json(
    { error: "Only league admins can edit this league" },
    { status: 403 }
  );
}

// Fields a league admin may change through PATCH. Add to this list as
// needed. Anything else is rejected, so a request can't touch id,
// sport, pitboss_status, discord_server_id and so on.
const PATCHABLE_FIELDS = ["name", "slug", "is_public"];

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabaseAdmin = getSupabaseAdmin();

  const { data, error } = await supabaseAdmin
    .from("leagues")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const denied = await requireLeagueAdmin(params.id);
  if (denied) return denied;

  const supabaseAdmin = getSupabaseAdmin();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const rejected = Object.keys(body).filter((k) => !PATCHABLE_FIELDS.includes(k));
  if (rejected.length > 0) {
    return NextResponse.json(
      { error: `Fields not editable: ${rejected.join(", ")}` },
      { status: 400 }
    );
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("leagues")
    .update(body)
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const denied = await requireLeagueAdmin(params.id);
  if (denied) return denied;

  const supabaseAdmin = getSupabaseAdmin();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Logo must be an image" }, { status: 400 });
  }
  if (file.size > MAX_LOGO_BYTES) {
    return NextResponse.json({ error: "Logo must be under 5 MB" }, { status: 400 });
  }

  // Letters and digits only, so the file name can't add path segments.
  const ext = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const path = `${params.id}/logo.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const storageClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: uploadError } = await storageClient.storage
    .from("league-logos")
    .upload(path, buffer, { upsert: true, contentType: file.type });

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: { publicUrl } } = storageClient.storage
    .from("league-logos")
    .getPublicUrl(path);

  const { data, error } = await supabaseAdmin
    .from("leagues")
    .update({ logo_url: publicUrl })
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // PitBoss keeps its own separate leagues table (it predates the merge
  // into Rise OS and serves a different domain — race governance vs.
  // dynasty/league management). If this league also has a matching
  // pitboss.leagues row, keep its logo_url in sync too. Otherwise
  // PitBoss-side pages (Standings, Results, etc.) silently keep showing
  // the old/broken logo after every future upload here, exactly like the
  // 7/20 incident where three leagues' pitboss.leagues rows were still
  // pointing at a non-existent logo.jpeg while rise_os.leagues was fine.
  const pitbossClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: "pitboss" } }
  );
  await pitbossClient
    .from("leagues")
    .update({ logo_url: publicUrl })
    .eq("id", params.id);
  // Not failing the request if this errors or matches zero rows (e.g. a
  // CFB dynasty league with no PitBoss presence) — the rise_os update
  // above already succeeded and is the source of truth for that domain.

  return NextResponse.json(data);
}
