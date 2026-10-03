import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { privateBucket } from "@/lib/cloudflare-bindings";
import { ensureHostelPayoutTables } from "@/lib/hostel-engine/payouts";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export type ReviewState = "PENDING" | "APPROVED" | "REJECTED";
export type AffiliationClaim = "AFFILIATED" | "INDEPENDENT" | "UNSURE";
export type IdentityKind = "IDENTITY" | "AUTHORITY";
export const IDENTITY_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const MAX_IDENTITY_BYTES = 6 * 1024 * 1024;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_owner_onboarding (
    landlord_id TEXT PRIMARY KEY, owner_role TEXT NOT NULL DEFAULT 'OWNER',
    profile_status TEXT NOT NULL DEFAULT 'PENDING', profile_reason TEXT NOT NULL DEFAULT '',
    profile_reviewed_by TEXT NOT NULL DEFAULT '', profile_reviewed_at TEXT NOT NULL DEFAULT '',
    payout_status TEXT NOT NULL DEFAULT 'PENDING', payout_reason TEXT NOT NULL DEFAULT '',
    payout_reviewed_by TEXT NOT NULL DEFAULT '', payout_reviewed_at TEXT NOT NULL DEFAULT '',
    payout_snapshot TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_identity_documents (
    id TEXT PRIMARY KEY, landlord_id TEXT NOT NULL, kind TEXT NOT NULL,
    r2_key TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_identity_landlord ON hostel_identity_documents(landlord_id,kind,uploaded_at DESC)",
  `CREATE TABLE IF NOT EXISTS hostel_property_affiliations (
    property_id TEXT PRIMARY KEY, claim TEXT NOT NULL DEFAULT 'UNSURE',
    status TEXT NOT NULL DEFAULT 'PENDING', evidence_note TEXT NOT NULL DEFAULT '',
    review_reason TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_affiliation_status ON hostel_property_affiliations(status,updated_at DESC)",
];
let ready: Promise<void> | null = null;
export function ensureHostelOnboardingTables() {
  ready ??= (async () => {
    await ensureHostelPayoutTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelOwnerOnboarding", version: "039_hostel_owner_onboarding", statements: STATEMENTS });
  })().catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

export async function createOwnerOnboarding(landlordId: string) {
  await ensureHostelOnboardingTables();
  await turso("INSERT OR IGNORE INTO hostel_owner_onboarding (landlord_id,updated_at) VALUES (?,?)", [landlordId, new Date().toISOString()]);
}

const OWNER_READINESS_SELECT = `SELECT h.id,h.name,h.phone,h.email,h.organization,h.status AS account_status,h.kyc_status,h.review_reason,
  COALESCE(o.owner_role,'OWNER') AS owner_role,
  COALESCE(o.profile_status,'PENDING') AS profile_status,COALESCE(o.profile_reason,'') AS profile_reason,
  COALESCE(o.payout_status,'PENDING') AS payout_status,COALESCE(o.payout_reason,'') AS payout_reason,
  COALESCE(o.payout_snapshot,'') AS payout_snapshot,
  COALESCE(h.payout_method,'') AS payout_method,COALESCE(h.payout_account_last4,'') AS payout_last4,
  COALESCE(h.payout_bank_code,'') AS payout_bank_code,COALESCE(h.payout_bank_name,'') AS payout_bank_name,COALESCE(h.payout_account_name,'') AS payout_account_name,COALESCE(h.payout_updated_at,'') AS payout_updated_at
  FROM hostel_landlords h LEFT JOIN hostel_owner_onboarding o ON o.landlord_id=h.id`;
function ownerReadinessView(row: Record<string, unknown>) {
  const landlordId = String(row.id);
  const payoutSnapshot = JSON.stringify([row.payout_method, row.payout_last4, row.payout_bank_code, row.payout_updated_at]);
  return {
    landlordId, name: String(row.name || ""), phone: String(row.phone || ""), email: String(row.email || ""),
    organization: String(row.organization || ""), ownerRole: String(row.owner_role || "OWNER"),
    accountStatus: String(row.account_status || "ACTIVE"), profileStatus: String(row.profile_status || "PENDING") as ReviewState,
    profileReason: String(row.profile_reason || ""), identityReason: String(row.review_reason || ""), identityStatus: String(row.kyc_status || "PENDING") as "PENDING" | "VERIFIED" | "REJECTED",
    payoutStatus: (String(row.payout_status) === "APPROVED" && String(row.payout_snapshot) === payoutSnapshot && row.payout_method && row.payout_last4 ? "APPROVED" : String(row.payout_status) === "REJECTED" ? "REJECTED" : "PENDING") as ReviewState,
    payoutReason: String(row.payout_reason || ""), hasPayoutDestination: Boolean(row.payout_method && row.payout_last4),
    payoutSummary: row.payout_method && row.payout_last4 ? `${String(row.payout_bank_name || row.payout_method)} · ${String(row.payout_account_name || "")} · ending ${String(row.payout_last4)}` : "",
  };
}
export async function ownerReadiness(landlordId: string) {
  await ensureHostelOnboardingTables();
  const row = rowsToObjects(await turso(`${OWNER_READINESS_SELECT} WHERE h.id=? LIMIT 1`, [landlordId]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That landlord account was not found.", 404);
  return ownerReadinessView(row);
}
export async function updateOwnerProfile(input: { landlordId: string; ownerRole: string; organization: string; actor: string }) {
  await createOwnerOnboarding(input.landlordId);
  const role = String(input.ownerRole || "").toUpperCase();
  if (!["OWNER", "AUTHORIZED_MANAGER", "COMPANY_REPRESENTATIVE"].includes(role)) throw new CampusEngineError("VALIDATION_ERROR", "Choose your relationship to the property.", 400);
  const organization = String(input.organization || "").trim().slice(0, 120);
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_landlords SET organization=?,updated_at=? WHERE id=?", [organization, stamp, input.landlordId]);
  await turso("UPDATE hostel_owner_onboarding SET owner_role=?,profile_status='PENDING',profile_reason='',profile_reviewed_by='',profile_reviewed_at='',updated_at=? WHERE landlord_id=?", [role, stamp, input.landlordId]);
  await consoleAudit({ actor: input.actor, action: "HOSTEL_PROFILE_SUBMITTED", targetType: "hostel_landlord", targetReference: input.landlordId, details: { ownerRole: role } }).catch(() => undefined);
  return ownerReadiness(input.landlordId);
}

export async function reviewOwnerStep(input: { landlordId: string; step: "PROFILE" | "IDENTITY" | "PAYOUT"; action: "APPROVE" | "REJECT"; reason?: string; actor: string }) {
  await createOwnerOnboarding(input.landlordId);
  const reason = String(input.reason || "").trim().slice(0, 500);
  if (input.action === "REJECT" && !reason) throw new CampusEngineError("VALIDATION_ERROR", "Explain what the owner needs to change.", 400);
  const stamp = new Date().toISOString();
  if (input.step === "IDENTITY") {
    if (input.action === "APPROVE") {
      const kinds = rowsToObjects(await turso("SELECT DISTINCT kind FROM hostel_identity_documents WHERE landlord_id=?", [input.landlordId])).map(row => String(row.kind));
      if (!kinds.includes("IDENTITY") || !kinds.includes("AUTHORITY")) throw new CampusEngineError("INVALID_STATE", "Review an identity document and proof of ownership or authority first.", 409);
    }
    await turso("UPDATE hostel_landlords SET kyc_status=?,review_reason=?,updated_at=? WHERE id=?", [input.action === "APPROVE" ? "VERIFIED" : "REJECTED", reason, stamp, input.landlordId]);
  } else if (input.step === "PROFILE") {
    await turso("UPDATE hostel_owner_onboarding SET profile_status=?,profile_reason=?,profile_reviewed_by=?,profile_reviewed_at=?,updated_at=? WHERE landlord_id=?", [input.action === "APPROVE" ? "APPROVED" : "REJECTED", reason, input.actor, stamp, stamp, input.landlordId]);
  } else {
    const row = rowsToObjects(await turso("SELECT COALESCE(payout_method,'') AS method,COALESCE(payout_account_last4,'') AS last4,COALESCE(payout_bank_code,'') AS bank_code,COALESCE(payout_updated_at,'') AS updated_at FROM hostel_landlords WHERE id=? LIMIT 1", [input.landlordId]))[0];
    if (input.action === "APPROVE" && (!row?.method || !row?.last4 || !row?.bank_code)) throw new CampusEngineError("INVALID_STATE", "The owner must save a bank or mobile money destination first.", 409);
    const snapshot = input.action === "APPROVE" ? JSON.stringify([row.method, row.last4, row.bank_code, row.updated_at]) : "";
    await turso("UPDATE hostel_owner_onboarding SET payout_status=?,payout_reason=?,payout_reviewed_by=?,payout_reviewed_at=?,payout_snapshot=?,updated_at=? WHERE landlord_id=?", [input.action === "APPROVE" ? "APPROVED" : "REJECTED", reason, input.actor, stamp, snapshot, stamp, input.landlordId]);
  }
  await consoleAudit({ actor: input.actor, action: `HOSTEL_${input.step}_${input.action}`, targetType: "hostel_landlord", targetReference: input.landlordId, details: { reason } }).catch(() => undefined);
  return ownerReadiness(input.landlordId);
}

export async function propertyAffiliation(propertyId: string) {
  await ensureHostelOnboardingTables();
  const row = rowsToObjects(await turso("SELECT claim,status,evidence_note,review_reason,reviewed_by,reviewed_at FROM hostel_property_affiliations WHERE property_id=? LIMIT 1", [propertyId]))[0];
  return { claim: String(row?.claim || "UNSURE") as AffiliationClaim, status: String(row?.status || "PENDING") as ReviewState, evidenceNote: String(row?.evidence_note || ""), reviewReason: String(row?.review_reason || ""), reviewedBy: String(row?.reviewed_by || ""), reviewedAt: String(row?.reviewed_at || "") };
}

export async function savePropertyAffiliation(input: { landlordId: string; propertyId: string; claim: string; evidenceNote: string; actor: string }) {
  await ensureHostelOnboardingTables();
  const owned = rowsToObjects(await turso("SELECT id FROM hostel_properties WHERE id=? AND landlord_id=? LIMIT 1", [input.propertyId, input.landlordId]))[0];
  if (!owned) throw new CampusEngineError("NOT_FOUND", "That property was not found.", 404);
  const claim = String(input.claim || "").toUpperCase();
  if (!["AFFILIATED", "INDEPENDENT", "UNSURE"].includes(claim)) throw new CampusEngineError("VALIDATION_ERROR", "Choose an affiliation option.", 400);
  const note = String(input.evidenceNote || "").trim().slice(0, 500);
  if (claim === "AFFILIATED" && note.length < 10) throw new CampusEngineError("VALIDATION_ERROR", "Explain the claimed university affiliation for staff review.", 400);
  const stamp = new Date().toISOString();
  await turso(`INSERT INTO hostel_property_affiliations (property_id,claim,status,evidence_note,updated_at) VALUES (?,?,'PENDING',?,?)
    ON CONFLICT(property_id) DO UPDATE SET claim=excluded.claim,status='PENDING',evidence_note=excluded.evidence_note,review_reason='',reviewed_by='',reviewed_at='',updated_at=excluded.updated_at`, [input.propertyId, claim, note, stamp]);
  await turso("UPDATE hostel_properties SET status='DRAFT',updated_at=? WHERE id=? AND status<>'SUSPENDED'", [stamp, input.propertyId]);
  await consoleAudit({ actor: input.actor, action: "HOSTEL_AFFILIATION_CLAIMED", targetType: "hostel_property", targetReference: input.propertyId, details: { claim } }).catch(() => undefined);
  return propertyAffiliation(input.propertyId);
}

export async function submitPropertyForReview(input: { landlordId: string; propertyId: string; actor: string }) {
  await ensureHostelOnboardingTables();
  const property = rowsToObjects(await turso("SELECT id,address,latitude,longitude,status FROM hostel_properties WHERE id=? AND landlord_id=? LIMIT 1", [input.propertyId, input.landlordId]))[0];
  if (!property) throw new CampusEngineError("NOT_FOUND", "That property was not found.", 404);
  if (String(property.status) === "SUSPENDED") throw new CampusEngineError("INVALID_STATE", "A suspended property cannot be submitted again by its owner.", 409);
  if (String(property.status) === "APPROVED") throw new CampusEngineError("INVALID_STATE", "This property is already approved. Only changed property details need a new review.", 409);
  if (String(property.status) === "PENDING_REVIEW") throw new CampusEngineError("INVALID_STATE", "This property is already waiting for staff review.", 409);
  if (!property.address || property.latitude == null || property.longitude == null) throw new CampusEngineError("INVALID_STATE", "Add an address and confirm the location pin first.", 409);
  const photos = rowsToObjects(await turso("SELECT id FROM hostel_property_photos WHERE property_id=? LIMIT 1", [input.propertyId]));
  if (!photos.length) throw new CampusEngineError("INVALID_STATE", "Upload at least one property photo before submitting.", 409);
  const stamp = new Date().toISOString();
  await turso("UPDATE hostel_properties SET status='PENDING_REVIEW',updated_at=? WHERE id=? AND landlord_id=?", [stamp, input.propertyId, input.landlordId]);
  await consoleAudit({ actor: input.actor, action: "HOSTEL_PROPERTY_SUBMITTED", targetType: "hostel_property", targetReference: input.propertyId, details: {} }).catch(() => undefined);
  return { propertyId: input.propertyId, status: "PENDING_REVIEW" };
}

export async function reviewProperty(input: { propertyId: string; action: "APPROVE" | "REJECT"; reason?: string; actor: string }) {
  await ensureHostelOnboardingTables();
  const property = rowsToObjects(await turso("SELECT id,name,address,latitude,longitude,status FROM hostel_properties WHERE id=? LIMIT 1", [input.propertyId]))[0];
  if (!property) throw new CampusEngineError("NOT_FOUND", "That property was not found.", 404);
  const reason = String(input.reason || "").trim().slice(0, 500);
  if (input.action === "REJECT" && !reason) throw new CampusEngineError("VALIDATION_ERROR", "Explain what must be corrected.", 400);
  if (String(property.status) !== "PENDING_REVIEW") throw new CampusEngineError("INVALID_STATE", "The owner must submit the property for review first.", 409);
  if (input.action === "APPROVE") {
    if (!property.address || property.latitude == null || property.longitude == null) throw new CampusEngineError("INVALID_STATE", "The property needs an address and confirmed location pin before approval.", 409);
    const approvedPhotos = rowsToObjects(await turso("SELECT id FROM hostel_property_photos WHERE property_id=? AND status='APPROVED' LIMIT 1", [input.propertyId]));
    if (!approvedPhotos.length) throw new CampusEngineError("INVALID_STATE", "Approve at least one property photo before approving the property.", 409);
  }
  const stamp = new Date().toISOString();
  const changed = await turso("UPDATE hostel_properties SET status=?,updated_at=? WHERE id=? AND status='PENDING_REVIEW'", [input.action === "APPROVE" ? "APPROVED" : "DRAFT", stamp, input.propertyId]);
  if (Number(changed?.affected_row_count || 0) !== 1) throw new CampusEngineError("INVALID_STATE", "The property's review state changed. Refresh the queue.", 409);
  await turso(`INSERT INTO hostel_property_affiliations (property_id,claim,status,review_reason,reviewed_by,reviewed_at,updated_at)
    VALUES (?,'UNSURE',?,?,?,?,?) ON CONFLICT(property_id) DO UPDATE SET status=excluded.status,review_reason=excluded.review_reason,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at`,
    [input.propertyId, input.action === "APPROVE" ? "APPROVED" : "REJECTED", reason, input.actor, stamp, stamp]);
  await consoleAudit({ actor: input.actor, action: `HOSTEL_PROPERTY_${input.action}`, targetType: "hostel_property", targetReference: input.propertyId, details: { reason } }).catch(() => undefined);
  return { propertyId: input.propertyId, status: input.action === "APPROVE" ? "APPROVED" : "DRAFT", affiliation: await propertyAffiliation(input.propertyId) };
}

export async function identityDocuments(landlordId: string) {
  await ensureHostelOnboardingTables();
  const rows = rowsToObjects(await turso("SELECT id,kind,content_type,bytes,uploaded_at FROM hostel_identity_documents WHERE landlord_id=? ORDER BY uploaded_at DESC", [landlordId]));
  return rows.map(row => ({ id: String(row.id), kind: String(row.kind) as IdentityKind, contentType: String(row.content_type), bytes: Number(row.bytes || 0), uploadedAt: String(row.uploaded_at) }));
}

export async function uploadIdentityDocument(input: { landlordId: string; kind: string; file: File; actor: string }) {
  await ensureHostelOnboardingTables();
  const kind = String(input.kind || "").toUpperCase();
  if (!["IDENTITY", "AUTHORITY"].includes(kind)) throw new CampusEngineError("VALIDATION_ERROR", "Choose identity or ownership evidence.", 400);
  if (!(IDENTITY_TYPES as readonly string[]).includes(input.file.type) || input.file.size <= 0 || input.file.size > MAX_IDENTITY_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Upload a JPEG, PNG, WebP or PDF under 6 MB.", 400);
  const bucket = await privateBucket() as { put(key: string, value: ArrayBuffer, options?: Record<string, unknown>): Promise<unknown> } | undefined;
  if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Private document storage is not configured.", 503);
  const id = crypto.randomUUID();
  const key = `hostel/identity/${input.landlordId}/${id}`;
  await bucket.put(key, await input.file.arrayBuffer(), { httpMetadata: { contentType: input.file.type } });
  await turso("INSERT INTO hostel_identity_documents (id,landlord_id,kind,r2_key,content_type,bytes,uploaded_at) VALUES (?,?,?,?,?,?,?)", [id, input.landlordId, kind, key, input.file.type, input.file.size, new Date().toISOString()]);
  await turso("UPDATE hostel_landlords SET kyc_status='PENDING',review_reason='',updated_at=? WHERE id=?", [new Date().toISOString(), input.landlordId]);
  await consoleAudit({ actor: input.actor, action: "HOSTEL_IDENTITY_UPLOADED", targetType: "hostel_identity_document", targetReference: id, details: { kind } }).catch(() => undefined);
  return { id, kind };
}

export async function identityDocumentFile(id: string, landlordId: string | null) {
  await ensureHostelOnboardingTables();
  const row = rowsToObjects(await turso("SELECT landlord_id,r2_key,content_type FROM hostel_identity_documents WHERE id=? LIMIT 1", [id]))[0];
  if (!row || (landlordId && String(row.landlord_id) !== landlordId)) throw new CampusEngineError("NOT_FOUND", "Document not found.", 404);
  const bucket = await privateBucket() as { get(key: string): Promise<{ body: ReadableStream } | null> } | undefined;
  if (!bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Private document storage is not configured.", 503);
  const file = await bucket.get(String(row.r2_key));
  if (!file) throw new CampusEngineError("NOT_FOUND", "Document not found.", 404);
  return { body: file.body, contentType: String(row.content_type || "application/octet-stream") };
}

export async function onboardingReviewQueue() {
  await ensureHostelOnboardingTables();
  const rows = rowsToObjects(await turso(`${OWNER_READINESS_SELECT} ORDER BY h.created_at DESC LIMIT 60`));
  const ids = rows.map(row => String(row.id));
  const documentRows = ids.length ? rowsToObjects(await turso(
    `SELECT id,landlord_id,kind,content_type,bytes,uploaded_at FROM hostel_identity_documents WHERE landlord_id IN (${ids.map(() => "?").join(",")}) ORDER BY uploaded_at DESC`, ids,
  )) : [];
  const documentsByOwner = new Map<string, Array<{ id: string; kind: IdentityKind; contentType: string; bytes: number; uploadedAt: string }>>();
  for (const row of documentRows) {
    const id = String(row.landlord_id);
    const documents = documentsByOwner.get(id) || [];
    documents.push({ id: String(row.id), kind: String(row.kind) as IdentityKind, contentType: String(row.content_type), bytes: Number(row.bytes || 0), uploadedAt: String(row.uploaded_at) });
    documentsByOwner.set(id, documents);
  }
  const owners = rows.map(row => ({ ...ownerReadinessView(row), documents: documentsByOwner.get(String(row.id)) || [] }));
  const properties = rowsToObjects(await turso(`SELECT p.id,p.name,p.address,p.latitude,p.longitude,p.status,p.landlord_id,
    (SELECT COUNT(*) FROM hostel_rooms r WHERE r.property_id=p.id AND r.status='ACTIVE') AS room_count,
    COALESCE(a.claim,'UNSURE') AS affiliation_claim,COALESCE(a.status,'PENDING') AS affiliation_status,
    COALESCE(a.evidence_note,'') AS evidence_note FROM hostel_properties p
    LEFT JOIN hostel_property_affiliations a ON a.property_id=p.id ORDER BY p.created_at DESC LIMIT 300`));
  return { owners, properties: properties.map(row => ({ id: String(row.id), name: String(row.name), address: String(row.address), latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude), roomCount: Number(row.room_count || 0), status: String(row.status), landlordId: String(row.landlord_id), affiliationClaim: String(row.affiliation_claim), affiliationStatus: String(row.affiliation_status), evidenceNote: String(row.evidence_note) })) };
}
