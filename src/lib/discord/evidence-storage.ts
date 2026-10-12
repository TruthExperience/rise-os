// src/lib/discord/evidence-storage.ts
//
// Copies Discord attachments into the private `incident-evidence` bucket
// and records them in pitboss.incident_evidence, so evidence survives
// Discord CDN link expiry (attachment URLs stop working after roughly a
// day). Links (YouTube, Twitch, Streamable, etc.) can't be downloaded, so
// they are recorded as source = 'link' and stored as typed.
//
// Storage references are saved as "storage:<path>" in the `url` column.
// The bucket is private, so anything that needs a clickable or fetchable
// URL (tickets, AI analysis, appeals) must pass the stored value through
// resolveEvidenceUrl / resolveEvidenceList to get a fresh signed URL.

import { createAdminClient } from "@/lib/supabase/server";

const BUCKET = "incident-evidence";
const STORAGE_PREFIX = "storage:";
const MAX_BYTES = 50 * 1024 * 1024; // refuse anything over 50 MB
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days, regenerated on every read

// Only fetch from Discord's own CDN. The attachment URL comes from the
// interaction payload, but this keeps the bot from ever being pointed at
// an arbitrary host.
const ALLOWED_FETCH_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export type EvidenceParty = "reporter" | "accused";
export type EvidenceAddedByRole = "reporter" | "accused" | "steward";

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function safeFileName(name: string | undefined): string {
  const base = (name ?? "evidence").split(/[\\/]/).pop() ?? "evidence";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (cleaned || "evidence").slice(-80);
}

/**
 * Downloads a Discord attachment and uploads it to the incident-evidence
 * bucket. Returns the storage reference to save in incident_evidence.url.
 */
export async function copyDiscordAttachmentToStorage(params: {
  incidentId: string;
  party: EvidenceParty;
  url: string;
  filename?: string;
  contentType?: string | null;
}): Promise<{ ref: string; path: string } | { error: string }> {
  let host: string;
  try {
    host = new URL(params.url).hostname;
  } catch {
    return { error: "That attachment URL isn't valid." };
  }
  if (!ALLOWED_FETCH_HOSTS.has(host)) {
    return { error: "Attachments can only be copied from Discord." };
  }

  let res: Response;
  try {
    res = await fetch(params.url);
  } catch (err) {
    console.error("[evidence-storage] attachment download failed:", err);
    return { error: "Couldn't download the attachment from Discord." };
  }
  if (!res.ok) {
    console.error("[evidence-storage] attachment download status:", res.status);
    return { error: `Discord returned ${res.status} for that attachment.` };
  }

  const declaredLength = Number(res.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BYTES) {
    return { error: "That file is over 50 MB — upload it somewhere and paste a link instead." };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    return { error: "That file is over 50 MB — upload it somewhere and paste a link instead." };
  }

  const contentType =
    params.contentType ?? res.headers.get("content-type") ?? "application/octet-stream";
  const path = `${params.incidentId}/${params.party}/${Date.now()}-${safeFileName(params.filename)}`;

  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: false });

  if (error) {
    console.error("[evidence-storage] upload failed:", error);
    return { error: "Couldn't save the file to evidence storage." };
  }

  return { ref: `${STORAGE_PREFIX}${path}`, path };
}

/**
 * Records one piece of evidence in pitboss.incident_evidence.
 * `url` is a storage reference for uploads, or the typed link for links.
 */
export async function recordIncidentEvidence(params: {
  incidentId: string;
  party: EvidenceParty;
  source: "upload" | "link";
  url: string;
  label?: string | null;
  addedByDriverId: string;
  addedByRole: EvidenceAddedByRole;
}): Promise<{ ok: true } | { error: string }> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .schema("pitboss")
    .from("incident_evidence")
    .insert({
      incident_id: params.incidentId,
      party: params.party,
      source: params.source,
      url: params.url,
      label: params.label ?? null,
      added_by: params.addedByDriverId,
      added_by_role: params.addedByRole,
    });

  if (error) {
    console.error("[evidence-storage] incident_evidence insert failed:", error);
    return { error: "Couldn't record the evidence on the incident." };
  }
  return { ok: true };
}

/**
 * Convenience wrapper: copy a Discord attachment to storage, then record it.
 * If the copy fails, nothing is recorded and the error comes back so the
 * caller can tell the user to retry (a raw Discord CDN link would die within
 * a day, so it is deliberately NOT used as a fallback).
 */
export async function addEvidenceFile(params: {
  incidentId: string;
  party: EvidenceParty;
  attachmentUrl: string;
  filename?: string;
  contentType?: string | null;
  addedByDriverId: string;
  addedByRole: EvidenceAddedByRole;
}): Promise<{ ok: true } | { error: string }> {
  const copied = await copyDiscordAttachmentToStorage({
    incidentId: params.incidentId,
    party: params.party,
    url: params.attachmentUrl,
    filename: params.filename,
    contentType: params.contentType,
  });
  if ("error" in copied) return copied;

  return recordIncidentEvidence({
    incidentId: params.incidentId,
    party: params.party,
    source: "upload",
    url: copied.ref,
    label: params.filename ?? null,
    addedByDriverId: params.addedByDriverId,
    addedByRole: params.addedByRole,
  });
}

/** Records a pasted link as-is (validate with isHttpUrl first). */
export async function addEvidenceLink(params: {
  incidentId: string;
  party: EvidenceParty;
  link: string;
  addedByDriverId: string;
  addedByRole: EvidenceAddedByRole;
}): Promise<{ ok: true } | { error: string }> {
  return recordIncidentEvidence({
    incidentId: params.incidentId,
    party: params.party,
    source: "link",
    url: params.link.trim(),
    addedByDriverId: params.addedByDriverId,
    addedByRole: params.addedByRole,
  });
}

/**
 * Turns a stored evidence value into a usable URL. Storage references get a
 * fresh 7-day signed URL; plain links (and legacy rows) pass through as-is.
 * Returns null if a storage reference can't be signed (e.g. file deleted).
 */
export async function resolveEvidenceUrl(stored: string): Promise<string | null> {
  if (!stored.startsWith(STORAGE_PREFIX)) return stored;

  const path = stored.slice(STORAGE_PREFIX.length);
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("[evidence-storage] signed URL failed:", error);
    return null;
  }
  return data.signedUrl;
}

/** Resolves a whole evidence list, dropping entries that can't be resolved. */
export async function resolveEvidenceList<T extends { url: string }>(
  items: T[]
): Promise<T[]> {
  const resolved = await Promise.all(
    items.map(async (item) => {
      const url = await resolveEvidenceUrl(item.url);
      return url ? { ...item, url } : null;
    })
  );
  return resolved.filter((item): item is T => item !== null);
}
