// src/lib/pitboss.ts

import { createClient } from "@supabase/supabase-js";
import type {
  Licence,
  LicenceWithRelations,
  IssueLicencePayload,
  UpdateLicencePayload,
  VerifyLicenceResult,
  Driver,
  DriverLeague,
} from "@/types/pitboss";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function certLabel(title: string, leagueSlug: string): string {
  const upper = leagueSlug.toUpperCase();
  const map: Record<string, string> = {
    STEWARD:              `CERTIFIED ${upper} STEWARD`,
    DRIVER:               `CERTIFIED ${upper} DRIVER`,
    "TEAM PRINCIPAL":     `CERTIFIED ${upper} TEAM PRINCIPAL`,
    "SPORTING DIRECTOR":  `CERTIFIED ${upper} SPORTING DIRECTOR`,
    "BROADCAST DIRECTOR": `CERTIFIED ${upper} BROADCAST DIRECTOR`,
    COMMISSIONER:         "LEAGUE COMMISSIONER",
    "BSAC OFFICER":       `CERTIFIED ${upper} BSAC OFFICER`,
    "CRRB OFFICER":       `CERTIFIED ${upper} CRRB OFFICER`,
    "SLB OFFICER":        `CERTIFIED ${upper} SLB OFFICER`,
  };
  return map[title.toUpperCase()] ?? `CERTIFIED ${upper} ${title.toUpperCase()}`;
}

export function resolveStatus(
  dbStatus: string,
  expiresAt: string | null
): "active" | "suspended" | "revoked" | "expired" {
  if (dbStatus === "revoked") return "revoked";
  if (dbStatus === "suspended") return "suspended";
  if (expiresAt && new Date(expiresAt) < new Date()) return "expired";
  return "active";
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

// ─── Licence queries ──────────────────────────────────────────────────────────

const LICENCE_SELECT = `
  id,
  licence_number,
  role_code,
  title,
  tier,
  era_endorsements,
  status,
  issued_at,
  expires_at,
  photo_url,
  qr_token,
  created_at,
  updated_at,
  driver:drivers (
    id,
    discord_username,
    display_name,
    discord_avatar,
    pp_total,
    super_licence_status
  ),
  league:leagues (
    id,
    name,
    slug
  )
`;

/** Fetch a single licence by qr_token UUID or licence_number string */
export async function fetchLicenceByToken(
  token: string
): Promise<LicenceWithRelations | null> {
  const isUUID = UUID_RE.test(token);
  const col = isUUID ? "qr_token" : "licence_number";

  const { data, error } = await supabase
    .from("licences")
    .select(LICENCE_SELECT)
    .schema("pitboss")
    .eq(col, token)
    .maybeSingle();

  if (error) throw error;
  return data as LicenceWithRelations | null;
}

/** Fetch a single licence by its UUID primary key */
export async function fetchLicenceById(
  id: string
): Promise<LicenceWithRelations | null> {
  const { data, error } = await supabase
    .from("licences")
    .select(LICENCE_SELECT)
    .schema("pitboss")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data as LicenceWithRelations | null;
}

/** Fetch all licences for a league (commissioner view) */
export async function fetchLicencesByLeague(
  leagueId: string
): Promise<LicenceWithRelations[]> {
  const { data, error } = await supabase
    .from("licences")
    .select(LICENCE_SELECT)
    .schema("pitboss")
    .eq("league_id", leagueId)
    .order("issued_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as LicenceWithRelations[];
}

/** Fetch all licences for a driver across all leagues */
export async function fetchLicencesByDriver(
  driverId: string
): Promise<LicenceWithRelations[]> {
  const { data, error } = await supabase
    .from("licences")
    .select(LICENCE_SELECT)
    .schema("pitboss")
    .eq("driver_id", driverId)
    .order("issued_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as LicenceWithRelations[];
}

/** Issue a new licence — calls the DB function which handles sequencing */
export async function issueLicence(
  payload: IssueLicencePayload
): Promise<Licence> {
  const { data, error } = await supabase
    .rpc("issue_licence", {
      p_driver_id:  payload.driver_id,
      p_league_id:  payload.league_id,
      p_role_code:  payload.role_code,
      p_title:      payload.title,
      p_tier:       payload.tier ?? null,
      p_photo_url:  payload.photo_url ?? null,
      p_expires_at: payload.expires_at ?? null,
    })
    .schema("pitboss");

  if (error) throw error;
  return data as Licence;
}

/** Update licence status, tier, era endorsements, photo, or expiry */
export async function updateLicence(
  id: string,
  payload: UpdateLicencePayload
): Promise<Licence> {
  const { data, error } = await supabase
    .from("licences")
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .schema("pitboss")
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data as Licence;
}

/** Revoke a licence — hard status change, logged */
export async function revokeLicence(id: string): Promise<Licence> {
  return updateLicence(id, { status: "revoked" });
}

/** Suspend a licence */
export async function suspendLicence(id: string): Promise<Licence> {
  return updateLicence(id, { status: "suspended" });
}

/** Reinstate a suspended licence */
export async function reinstateLicence(id: string): Promise<Licence> {
  return updateLicence(id, { status: "active" });
}

/** Auto-patch expired licences found during verify */
export async function markExpired(id: string): Promise<void> {
  await supabase
    .from("licences")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .schema("pitboss")
    .eq("id", id);
}

// ─── Verify (used by API route + public page) ─────────────────────────────────

export async function verifyLicence(
  token: string
): Promise<VerifyLicenceResult> {
  try {
    const licence = await fetchLicenceByToken(token);

    if (!licence) {
      return {
        valid: false,
        reason: "not_found",
        message:
          "Licence not found. This QR code may be invalid or the licence has been deleted.",
      };
    }

    const driver = licence.driver as any;
    const league = licence.league as any;
    const liveStatus = resolveStatus(licence.status, licence.expires_at);

    if (liveStatus === "expired" && licence.status === "active") {
      await markExpired(licence.id);
    }

    const holderName =
      driver?.display_name || driver?.discord_username || "Unknown";

    return {
      valid: true,
      licenceNumber:       licence.licence_number,
      holderName,
      title:               licence.title,
      tier:                licence.tier ?? null,
      eraEndorsements:     licence.era_endorsements ?? [],
      leagueName:          league?.name ?? "",
      leagueSlug:          league?.slug?.toUpperCase() ?? "",
      status:              liveStatus,
      issuedAt:            formatDate(licence.issued_at),
      expiresAt:           licence.expires_at ? formatDate(licence.expires_at) : null,
      certifiedLabel:      certLabel(licence.title, league?.slug ?? ""),
      photoUrl:            licence.photo_url ?? null,
      ppTotal:             driver?.pp_total ?? 0,
      superLicenceStatus:  driver?.super_licence_status ?? "active",
      verifiedAt:          new Date().toISOString(),
    };
  } catch (err) {
    console.error("[verifyLicence]", err);
    return {
      valid: false,
      reason: "error",
      message: "Verification service unavailable. Please try again.",
    };
  }
}

// ─── Driver queries ───────────────────────────────────────────────────────────

export async function fetchDriverById(
  id: string
): Promise<Driver | null> {
  const { data, error } = await supabase
    .from("drivers")
    .select("*")
    .schema("pitboss")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data as Driver | null;
}

export async function fetchDriverByDiscordId(
  discordId: string
): Promise<Driver | null> {
  const { data, error } = await supabase
    .from("drivers")
    .select("*")
    .schema("pitboss")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error) throw error;
  return data as Driver | null;
}

export async function fetchDriverLeagues(
  driverId: string
): Promise<DriverLeague[]> {
  const { data, error } = await supabase
    .from("driver_leagues")
    .select("*")
    .schema("pitboss")
    .eq("driver_id", driverId);

  if (error) throw error;
  return (data ?? []) as DriverLeague[];
}
