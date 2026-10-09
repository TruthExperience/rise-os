import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getLeagueAccess } from "@/lib/leagueAdmin";

export const dynamic = "force-dynamic";

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

// Lazy singleton — constructed on first use inside a handler, not at
// module load. Avoids "supabaseUrl is required" during Next.js's
// build-time page-data collection.
// Typed `any` deliberately: SupabaseClient's schema generic defaults to
// "public", so annotating this with the plain SupabaseClient type rejects
// a client built with `{ db: { schema: "rise_os" } }` at compile time.
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

export async function GET(_req: Request, { params }: { params: { leagueId: string; franchiseId: string } }) {
  const supabaseAdmin = getSupabaseAdmin();

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .select("*, league:leagues(sport)")
    .eq("id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

// Fields a league admin may change through PATCH. gm_id, espn_team_id,
// cap figures and the like are not editable here.
const PATCHABLE_FIELDS = ["name", "abbreviation", "primary_color", "secondary_color"];

export async function PATCH(req: Request, { params }: { params: { leagueId: string; franchiseId: string } }) {
  const access = await getLeagueAccess(params.leagueId);
  if (!access.userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (!access.isAdmin) {
    return NextResponse.json({ error: "Only league admins can edit franchises" }, { status: 403 });
  }

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
    return NextResponse.json({ error: `Fields not editable: ${rejected.join(", ")}` }, { status: 400 });
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .update(body)
    .eq("id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PUT(req: Request, { params }: { params: { leagueId: string; franchiseId: string } }) {
  // The logo can be changed by a league admin or by this franchise's GM.
  const access = await getLeagueAccess(params.leagueId);
  if (!access.userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const supabaseAdmin = getSupabaseAdmin();

  if (!access.isAdmin) {
    const { data: franchise } = await supabaseAdmin
      .from("franchises")
      .select("gm_id")
      .eq("id", params.franchiseId)
      .eq("league_id", params.leagueId)
      .maybeSingle();
    if (!franchise || franchise.gm_id !== access.userId) {
      return NextResponse.json(
        { error: "Only league admins or this franchise's GM can change the logo" },
        { status: 403 }
      );
    }
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Logo must be an image" }, { status: 400 });
  }
  if (file.size > MAX_LOGO_BYTES) {
    return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 });
  }

  // Letters and digits only, so the file name can't add path segments.
  const ext = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const path = `${params.franchiseId}/logo.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Separate client for storage — no schema restriction needed here since
  // this only touches the storage API, not postgrest tables. Already
  // constructed inside the handler, so this one was never part of the bug.
  const storageClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: uploadError } = await storageClient.storage
    .from("franchise-logos")
    .upload(path, buffer, { upsert: true, contentType: file.type });

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: { publicUrl } } = storageClient.storage
    .from("franchise-logos")
    .getPublicUrl(path);

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .update({ logo_url: publicUrl })
    .eq("id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}
