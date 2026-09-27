import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelPhotoTables } from "@/lib/hostel-engine/photos";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export const VERIFICATION_KINDS = ["LOCATION", "UTILITIES", "SAFETY"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];
export type PublicVerification = { id: string; kind: VerificationKind | "PHOTOS"; checkedAt: string; checkedBy: string; note: string; photoCount?: number };
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_property_verifications (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, snapshot TEXT NOT NULL, note TEXT NOT NULL,
    reviewed_by TEXT NOT NULL, reviewed_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_verifications_property ON hostel_property_verifications(property_id,kind,reviewed_at DESC)",
];
let ready: Promise<void> | null = null;
export function ensureHostelVerificationTables() {
  ready ??= (async () => {
    await ensureHostelPhotoTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelPropertyVerifications", version: "028_hostel_property_verifications", statements: STATEMENTS });
  })().catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

async function snapshot(propertyId: string, kind: VerificationKind) {
  const property = rowsToObjects(await turso(
    "SELECT id,address,latitude,longitude,utilities_enabled,updated_at FROM hostel_properties WHERE id=? LIMIT 1", [propertyId],
  ))[0];
  if (!property) throw new CampusEngineError("NOT_FOUND", "That property was not found.", 404);
  if (kind === "LOCATION") {
    if (property.latitude == null || property.longitude == null) throw new CampusEngineError("VALIDATION_ERROR", "Add a location pin before staff can check it.", 400);
    return JSON.stringify([String(property.address || ""), Number(property.latitude), Number(property.longitude)]);
  }
  if (kind === "UTILITIES") {
    const rooms = rowsToObjects(await turso(
      "SELECT id,utilities_fee FROM hostel_rooms WHERE property_id=? AND COALESCE(status,'ACTIVE')='ACTIVE' ORDER BY id", [propertyId],
    ));
    return JSON.stringify([Number(property.utilities_enabled || 0), rooms.map(room => [String(room.id), Number(room.utilities_fee || 0)])]);
  }
  return String(property.updated_at || "");
}

export async function recordHostelVerification(input: { propertyId: string; kind: string; action: string; note: string; actor: string }) {
  await ensureHostelVerificationTables();
  const propertyId = String(input.propertyId || "").trim();
  const kind = String(input.kind || "").toUpperCase() as VerificationKind;
  const action = String(input.action || "").toUpperCase();
  const note = String(input.note || "").trim();
  if (!propertyId || propertyId.length > 80 || !VERIFICATION_KINDS.includes(kind)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a property and a detail to check.", 400);
  if (!["CHECK", "REVOKE"].includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose check or revoke.", 400);
  if (note.length < 20 || note.length > 500) throw new CampusEngineError("VALIDATION_ERROR", "Record what staff checked in 20 to 500 characters.", 400);
  const state = await snapshot(propertyId, kind);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    "INSERT INTO hostel_property_verifications (id,property_id,kind,status,snapshot,note,reviewed_by,reviewed_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, propertyId, kind, action === "CHECK" ? "CHECKED" : "REVOKED", state, note, input.actor, stamp],
  );
  await consoleAudit({ actor: input.actor, action: `HOSTEL_${kind}_${action}`, targetType: "hostel_property_verification", targetReference: id, details: { propertyId, note } }).catch(() => undefined);
  return { id, propertyId, kind, status: action === "CHECK" ? "CHECKED" : "REVOKED", note, reviewedBy: input.actor, reviewedAt: stamp };
}

export async function listHostelVerificationWorkspace() {
  await ensureHostelVerificationTables();
  const properties = rowsToObjects(await turso("SELECT id,name,status FROM hostel_properties ORDER BY name COLLATE NOCASE ASC LIMIT 300"));
  const records = rowsToObjects(await turso("SELECT id,property_id,kind,status,note,reviewed_by,reviewed_at FROM hostel_property_verifications ORDER BY reviewed_at DESC,rowid DESC LIMIT 300"));
  return { properties: properties.map(row => ({ id: String(row.id), name: String(row.name), status: String(row.status) })), records: records.map(row => ({ id: String(row.id), propertyId: String(row.property_id), kind: String(row.kind), status: String(row.status), note: String(row.note), reviewedBy: String(row.reviewed_by), reviewedAt: String(row.reviewed_at) })) };
}

/** Only current claims survive; a changed pin, fee or property sends staff back to review. */
export async function listPublicHostelVerifications(propertyId: string): Promise<PublicVerification[]> {
  await ensureHostelVerificationTables();
  const rows = rowsToObjects(await turso(
    `SELECT id,kind,status,snapshot,note,reviewed_by,reviewed_at FROM hostel_property_verifications
     WHERE property_id=? ORDER BY reviewed_at DESC,rowid DESC`, [propertyId],
  ));
  const result: PublicVerification[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const kind = String(row.kind) as VerificationKind;
    if (seen.has(kind) || !VERIFICATION_KINDS.includes(kind)) continue;
    seen.add(kind);
    if (String(row.status) !== "CHECKED" || String(row.snapshot) !== await snapshot(propertyId, kind)) continue;
    result.push({ id: String(row.id), kind, checkedAt: String(row.reviewed_at), checkedBy: String(row.reviewed_by), note: String(row.note) });
  }
  const photoRows = rowsToObjects(await turso(
    `SELECT id,reviewed_at,reviewed_by FROM hostel_property_photos
     WHERE property_id=? AND status='APPROVED' AND reviewed_at<>'' ORDER BY reviewed_at DESC`, [propertyId],
  ));
  if (photoRows.length) result.push({ id: String(photoRows[0].id), kind: "PHOTOS", checkedAt: String(photoRows[0].reviewed_at), checkedBy: String(photoRows[0].reviewed_by), note: "Approved images were reviewed individually before publication.", photoCount: photoRows.length });
  return result;
}
