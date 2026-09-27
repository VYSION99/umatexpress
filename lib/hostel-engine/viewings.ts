import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { queueNotification } from "@/lib/notifications";
import { ensureNotificationsTable, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hostel_viewing_slots (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_viewing_slots_property ON hostel_viewing_slots(property_id,starts_at,status)",
  `CREATE TABLE IF NOT EXISTS hostel_viewing_requests (
    id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, property_id TEXT NOT NULL,
    student_email TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(slot_id,student_email)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_viewing_requests_slot ON hostel_viewing_requests(slot_id,status)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_viewing_requests_student ON hostel_viewing_requests(student_email,created_at DESC)",
];
let ready: Promise<void> | null = null;
export function ensureHostelViewingTables() {
  ready ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelViewings", version: "029_hostel_viewings", statements: SCHEMA });
  })().catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

function slotView(row: Record<string, unknown>) {
  return {
    id: String(row.id), propertyId: String(row.property_id), startsAt: String(row.starts_at), endsAt: String(row.ends_at),
    capacity: Number(row.capacity), status: String(row.status), taken: Number(row.taken || 0),
    myStatus: String(row.my_status || ""), myRequestId: String(row.my_request_id || ""),
  };
}
function requestView(row: Record<string, unknown>) {
  return { id: String(row.id), slotId: String(row.slot_id), propertyId: String(row.property_id), studentEmail: String(row.student_email), note: String(row.note || ""), status: String(row.status), startsAt: String(row.starts_at || ""), createdAt: String(row.created_at) };
}
async function propertyForLandlord(landlordId: string, propertyId: string) {
  const row = rowsToObjects(await turso("SELECT id,name FROM hostel_properties WHERE id=? AND landlord_id=? LIMIT 1", [propertyId, landlordId]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That property is not in your workspace.", 404);
  return row;
}

export async function listPublicViewingSlots(propertyId: string, studentEmail = "") {
  await ensureHostelViewingTables();
  const rows = rowsToObjects(await turso(
    `SELECT s.*, (SELECT COUNT(*) FROM hostel_viewing_requests r WHERE r.slot_id=s.id AND r.status IN ('PENDING','CONFIRMED')) AS taken,
       COALESCE((SELECT r.status FROM hostel_viewing_requests r WHERE r.slot_id=s.id AND r.student_email=? LIMIT 1),'') AS my_status,
       COALESCE((SELECT r.id FROM hostel_viewing_requests r WHERE r.slot_id=s.id AND r.student_email=? LIMIT 1),'') AS my_request_id
     FROM hostel_viewing_slots s
     WHERE s.property_id=? AND s.starts_at>? AND EXISTS (SELECT 1 FROM hostel_properties p WHERE p.id=s.property_id AND COALESCE(p.status,'DRAFT')<>'SUSPENDED')
       AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_spaces sp ON sp.id=l.space_id JOIN hostel_rooms rm ON rm.id=sp.room_id JOIN hostel_periods pe ON pe.id=l.period_id WHERE rm.property_id=s.property_id AND l.status='APPROVED' AND COALESCE(pe.active,1)=1)
       AND (s.status='OPEN' OR EXISTS
       (SELECT 1 FROM hostel_viewing_requests r WHERE r.slot_id=s.id AND r.student_email=?))
     ORDER BY s.starts_at ASC LIMIT 40`, [studentEmail.toLowerCase(), studentEmail.toLowerCase(), propertyId, new Date().toISOString(), studentEmail.toLowerCase()],
  ));
  return rows.map(slotView);
}

export async function listLandlordViewings(landlordId: string, propertyId: string) {
  await ensureHostelViewingTables();
  await propertyForLandlord(landlordId, propertyId);
  const slots = rowsToObjects(await turso(
    `SELECT s.*, (SELECT COUNT(*) FROM hostel_viewing_requests r WHERE r.slot_id=s.id AND r.status IN ('PENDING','CONFIRMED')) AS taken
     FROM hostel_viewing_slots s WHERE s.property_id=? AND s.starts_at>? ORDER BY s.starts_at ASC LIMIT 80`, [propertyId, new Date(Date.now() - 86_400_000).toISOString()],
  )).map(slotView);
  const requests = rowsToObjects(await turso(
    `SELECT r.*,s.starts_at FROM hostel_viewing_requests r JOIN hostel_viewing_slots s ON s.id=r.slot_id
     WHERE r.property_id=? AND s.starts_at>? ORDER BY s.starts_at ASC,r.created_at ASC LIMIT 200`, [propertyId, new Date(Date.now() - 86_400_000).toISOString()],
  )).map(requestView);
  return { slots, requests };
}

export async function createHostelViewingSlot(input: { landlordId: string; propertyId: string; startsAt: unknown; endsAt: unknown; capacity: unknown; actor: string }) {
  await ensureHostelViewingTables();
  const propertyId = String(input.propertyId || "").trim();
  await propertyForLandlord(input.landlordId, propertyId);
  const start = new Date(String(input.startsAt || ""));
  const end = new Date(String(input.endsAt || ""));
  const capacity = Number(input.capacity);
  const now = Date.now();
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start.getTime() < now + 15 * 60_000 || start.getTime() > now + 90 * 86_400_000 || end.getTime() - start.getTime() < 15 * 60_000 || end.getTime() - start.getTime() > 120 * 60_000) throw new CampusEngineError("VALIDATION_ERROR", "Choose a slot 15 minutes to 90 days ahead, lasting 15 to 120 minutes.", 400);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10) throw new CampusEngineError("VALIDATION_ERROR", "Choose room for 1 to 10 visitors.", 400);
  const id = crypto.randomUUID(); const stamp = new Date().toISOString();
  const inserted = await turso(
    `INSERT INTO hostel_viewing_slots (id,property_id,starts_at,ends_at,capacity,status,created_at,updated_at)
     SELECT ?,?,?,?,?,'OPEN',?,? WHERE NOT EXISTS
       (SELECT 1 FROM hostel_viewing_slots WHERE property_id=? AND status='OPEN' AND starts_at<? AND ends_at>?)`,
    [id, propertyId, start.toISOString(), end.toISOString(), capacity, stamp, stamp, propertyId, end.toISOString(), start.toISOString()],
  );
  if (!Number(inserted.affected_row_count)) throw new CampusEngineError("CONFLICT", "This property already has a viewing in that time window.", 409);
  await consoleAudit({ actor: input.actor, action: "HOSTEL_VIEWING_SLOT_OPENED", targetType: "hostel_viewing_slot", targetReference: id, details: { propertyId, startsAt: start.toISOString(), capacity } }).catch(() => undefined);
  return listLandlordViewings(input.landlordId, propertyId);
}

export async function requestHostelViewing(input: { email: string; propertyId: string; slotId: string; note?: string }) {
  await ensureHostelViewingTables();
  const propertyId = String(input.propertyId || "").trim();
  const slotId = String(input.slotId || "").trim();
  const email = input.email.toLowerCase();
  const note = String(input.note || "").trim();
  if (!propertyId || !slotId || propertyId.length > 80 || slotId.length > 80 || note.length > 300) throw new CampusEngineError("VALIDATION_ERROR", "Choose a viewing slot and keep your note under 300 characters.", 400);
  const stamp = new Date().toISOString();
  // The conditional INSERT is one SQLite statement: two students cannot take the final place.
  const result = await turso(
    `INSERT INTO hostel_viewing_requests (id,slot_id,property_id,student_email,note,status,created_at,updated_at)
     SELECT ?,s.id,s.property_id,?,?,'PENDING',?,? FROM hostel_viewing_slots s
     WHERE s.id=? AND s.property_id=? AND s.status='OPEN' AND s.starts_at>?
       AND (SELECT COUNT(*) FROM hostel_viewing_requests r WHERE r.slot_id=s.id AND r.status IN ('PENDING','CONFIRMED'))<s.capacity
       AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_spaces sp ON sp.id=l.space_id
         JOIN hostel_rooms rm ON rm.id=sp.room_id JOIN hostel_periods pe ON pe.id=l.period_id
         WHERE rm.property_id=s.property_id AND l.status='APPROVED' AND COALESCE(pe.active,1)=1)
       AND EXISTS (SELECT 1 FROM hostel_properties p WHERE p.id=s.property_id AND COALESCE(p.status,'DRAFT')<>'SUSPENDED')
     ON CONFLICT(slot_id,student_email) DO UPDATE SET status='PENDING',note=excluded.note,updated_at=excluded.updated_at
       WHERE hostel_viewing_requests.status='CANCELLED'`,
    [crypto.randomUUID(), email, note, stamp, stamp, slotId, propertyId, stamp],
  );
  if (!Number(result.affected_row_count)) throw new CampusEngineError("CONFLICT", "This viewing is full, closed, or already requested. Choose another slot.", 409);
  return listPublicViewingSlots(propertyId, email);
}

export async function cancelStudentViewing(email: string, requestId: string) {
  await ensureHostelViewingTables();
  const result = await turso("UPDATE hostel_viewing_requests SET status='CANCELLED',updated_at=? WHERE id=? AND student_email=? AND status IN ('PENDING','CONFIRMED')", [new Date().toISOString(), requestId, email.toLowerCase()]);
  if (!Number(result.affected_row_count)) throw new CampusEngineError("NOT_FOUND", "That active viewing request was not found.", 404);
  return { id: requestId, status: "CANCELLED" };
}

export async function manageHostelViewing(input: { landlordId: string; propertyId: string; action: string; slotId?: string; requestId?: string; actor: string }) {
  await ensureHostelViewingTables();
  const property = await propertyForLandlord(input.landlordId, input.propertyId);
  const action = String(input.action || "").toUpperCase();
  const stamp = new Date().toISOString();
  let recipients: string[] = [];
  let reference = "";
  if (action === "CANCEL_SLOT") {
    const slotId = String(input.slotId || "");
    const updated = await turso("UPDATE hostel_viewing_slots SET status='CANCELLED',updated_at=? WHERE id=? AND property_id=? AND status='OPEN'", [stamp, slotId, input.propertyId]);
    if (!Number(updated.affected_row_count)) throw new CampusEngineError("NOT_FOUND", "That open slot was not found.", 404);
    recipients = rowsToObjects(await turso("SELECT student_email FROM hostel_viewing_requests WHERE slot_id=? AND status IN ('PENDING','CONFIRMED')", [slotId])).map(row => String(row.student_email));
    await turso("UPDATE hostel_viewing_requests SET status='CANCELLED',updated_at=? WHERE slot_id=? AND status IN ('PENDING','CONFIRMED')", [stamp, slotId]);
    reference = slotId;
  } else if (action === "CONFIRM" || action === "DECLINE") {
    const requestId = String(input.requestId || "");
    const next = action === "CONFIRM" ? "CONFIRMED" : "DECLINED";
    const updated = await turso(
      `UPDATE hostel_viewing_requests SET status=?,updated_at=? WHERE id=? AND property_id=? AND status='PENDING'
       AND EXISTS (SELECT 1 FROM hostel_viewing_slots s WHERE s.id=slot_id AND s.status='OPEN' AND s.starts_at>?)`,
      [next, stamp, requestId, input.propertyId, stamp],
    );
    if (!Number(updated.affected_row_count)) throw new CampusEngineError("INVALID_STATE", "That pending request is no longer available.", 409);
    recipients = rowsToObjects(await turso("SELECT student_email FROM hostel_viewing_requests WHERE id=?", [requestId])).map(row => String(row.student_email));
    reference = requestId;
  } else throw new CampusEngineError("VALIDATION_ERROR", "Choose confirm, decline, or cancel slot.", 400);
  await consoleAudit({ actor: input.actor, action: `HOSTEL_VIEWING_${action}`, targetType: "hostel_viewing", targetReference: reference, details: { propertyId: input.propertyId } }).catch(() => undefined);
  if (recipients.length) {
    await ensureNotificationsTable();
    for (const recipient of recipients) {
      await queueNotification(turso, { recipient, template: `hostel_viewing_${action.toLowerCase()}`, subject: `${String(property.name)} viewing update`, message: `Your viewing at ${String(property.name)} was ${action === "CONFIRM" ? "confirmed" : action === "DECLINE" ? "declined" : "cancelled"}. Check the latest times at /hostel/${encodeURIComponent(input.propertyId)}.`, reference: `hostel-viewing:${reference}:${recipient}:${action}`, nowIso: stamp }).catch(() => undefined);
    }
  }
  return listLandlordViewings(input.landlordId, input.propertyId);
}
