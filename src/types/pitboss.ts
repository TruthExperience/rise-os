export type DriverTier = "academy" | "apex" | "apex_pro" | "elite";

export type DriverRole =
  | "driver"
  | "reserve"
  | "steward"
  | "commissioner";

export type LicenceStatus = "active" | "suspended" | "revoked" | "expired";

export type SuperLicenceStatus = "active" | "review" | "suspended" | "revoked";

export type CertificationStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed";

export type IncidentStatus =
  | "open"
  | "under_review"
  | "resolved"
  | "dismissed";

export type PlayerStatus =
  | "active"
  | "inactive"
  | "free_agent"
  | "retired";

export type Platform = "pc" | "ps5" | "xbox";

export type RoleCode =
  | "D"    // Driver
  | "S"    // Steward
  | "TP"   // Team Principal
  | "SD"   // Sporting Director
  | "BC"   // Broadcast Director
  | "TD"   // Technical Director
  | "BSAC" // BSAC Officer
  | "CRRB" // CRRB Officer
  | "SLB"  // SLB Officer
  | "STAFF"// Team Staff
  | "C";   // Commissioner

export type EraEndorsement = "E-GE" | "E-AP" | "E-NC";

// ─── Core entities ────────────────────────────────────────────────────────────

export interface Driver {
  id: string;
  discord_id: string;
  discord_username: string;
  discord_avatar: string | null;
  display_name: string | null;
  tier: DriverTier;
  era_endorsements: EraEndorsement[];
  pp_total: number;
  super_licence_status: SuperLicenceStatus;
  created_at: string;
  updated_at: string;
}

export interface DriverLeague {
  id: string;
  driver_id: string;
  league_id: string;
  role: DriverRole;
  certified: boolean;
  certified_at: string | null;
  joined_at: string;
}

export interface Licence {
  id: string;
  driver_id: string;
  league_id: string;
  licence_number: string;       // e.g. TRL-S-39257
  role_code: RoleCode;
  title: string;                // e.g. STEWARD
  tier: DriverTier | null;      // driver licences only
  era_endorsements: EraEndorsement[];
  status: LicenceStatus;
  issued_at: string;
  expires_at: string | null;
  photo_url: string | null;
  qr_token: string;             // UUID used for QR verification URL
  created_at: string;
  updated_at: string;
}

export interface LicenceSequence {
  id: string;
  league_id: string;
  role_code: RoleCode;
  last_number: number;
  created_at: string;
}

export interface DriverGamertag {
  id: string;
  driver_id: string;
  platform: Platform;
  gamertag: string;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface Certification {
  id: string;
  driver_id: string;
  league_id: string;
  status: CertificationStatus;
  score: number | null;
  pass_mark: number;
  started_at: string | null;
  completed_at: string | null;
  locked_until: string | null;  // 24hr lockout on failure
  token: string | null;         // issued on pass
  attempt_number: number;
  created_at: string;
}

export interface Question {
  id: string;
  league_id: string | null;
  category: string;
  question: string;
  options: Record<string, string>; // { A: "...", B: "...", C: "...", D: "..." }
  correct_answer: string;
  explanation: string | null;
  difficulty: "easy" | "medium" | "hard";
  generated_by: string;
  active: boolean;
  created_at: string;
}

export interface Incident {
  id: string;
  league_id: string;
  reported_by: string;
  accused_driver_id: string | null;
  season: string | null;
  round: number | null;
  lap: number | null;
  incident_type: string;
  description: string;
  evidence_urls: string[];
  status: IncidentStatus;
  verdict: string | null;
  penalty: string | null;
  penalty_points: number;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface PenaltyLedgerEntry {
  id: string;
  driver_id: string;
  league_id: string;
  incident_id: string | null;
  points: number;
  reason: string;
  issued_at: string;
  expires_at: string | null;
}

export interface RaceResult {
  id: string;
  league_id: string;
  driver_id: string;
  season: string;
  round: number;
  track: string | null;
  qualifying_position: number | null;
  finish_position: number | null;
  dnf: boolean;
  dnf_reason: string | null;
  fastest_lap: boolean;
  points_earned: number;
  penalty_points_added: number;
  created_at: string;
}

// ─── Joined / view types ──────────────────────────────────────────────────────

/** Full licence with driver + league data joined */
export interface LicenceWithRelations extends Licence {
  driver: Pick<Driver,
    | "id"
    | "discord_username"
    | "display_name"
    | "discord_avatar"
    | "pp_total"
    | "super_licence_status"
  >;
  league: {
    id: string;
    name: string;
    slug: string;
  };
}

/** Shape returned by GET /api/pitboss/verify/[token] */
export interface VerifyLicenceResponse {
  valid: true;
  licenceNumber: string;
  holderName: string;
  title: string;
  tier: DriverTier | null;
  eraEndorsements: EraEndorsement[];
  leagueName: string;
  leagueSlug: string;
  status: LicenceStatus;
  issuedAt: string;
  expiresAt: string | null;
  certifiedLabel: string;
  photoUrl: string | null;
  ppTotal: number;
  superLicenceStatus: SuperLicenceStatus;
  verifiedAt: string;
}

export interface VerifyLicenceError {
  valid: false;
  reason: "not_found" | "error";
  message: string;
}

export type VerifyLicenceResult = VerifyLicenceResponse | VerifyLicenceError;

/** Shape for POST /api/pitboss/licences */
export interface IssueLicencePayload {
  driver_id: string;
  league_id: string;
  role_code: RoleCode;
  title: string;
  tier?: DriverTier;
  photo_url?: string;
  expires_at?: string; // ISO string
}

/** Shape for PATCH /api/pitboss/licences/[licenceId] */
export interface UpdateLicencePayload {
  status?: LicenceStatus;
  tier?: DriverTier;
  era_endorsements?: EraEndorsement[];
  photo_url?: string;
  expires_at?: string | null;
}

// ─── API response wrappers ────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  data: T;
  error: null;
}

export interface ApiError {
  data: null;
  error: string;
