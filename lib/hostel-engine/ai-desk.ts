import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { getPublicProperty } from "@/lib/hostel-engine/listings";
import { queueNotification } from "@/lib/notifications";
import { ensureNotificationsTable, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hostel_ai_entries (
    id TEXT PRIMARY KEY,property_id TEXT NOT NULL,room_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ACTIVE',
    updated_by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_ai_entries_property ON hostel_ai_entries(property_id,status,updated_at DESC)",
  `CREATE TABLE IF NOT EXISTS hostel_ai_inquiries (
    id TEXT PRIMARY KEY,property_id TEXT NOT NULL,question TEXT NOT NULL,
    contact_name TEXT NOT NULL,contact_email TEXT NOT NULL,assistant_answer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN',staff_reply TEXT NOT NULL DEFAULT '',
    replied_by TEXT NOT NULL DEFAULT '',replied_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_ai_inquiries_property ON hostel_ai_inquiries(property_id,status,created_at DESC)",
];
let ready: Promise<void> | null = null;
export function ensureHostelAiDeskTables() {
  ready ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelAiDesk", version: "040_hostel_ai_desk", statements: SCHEMA });
  })().catch((error: unknown) => { ready = null; throw error; });
  return ready;
}
function entryView(row: Record<string, unknown>) {
  return { id: String(row.id), propertyId: String(row.property_id), roomId: String(row.room_id || ""), roomLabel: String(row.room_label || ""), title: String(row.title), content: String(row.content), updatedBy: String(row.updated_by || ""), updatedAt: String(row.updated_at) };
}
function inquiryView(row: Record<string, unknown>) {
  return { id: String(row.id), propertyId: String(row.property_id), propertyName: String(row.property_name || ""), question: String(row.question), contactName: String(row.contact_name), contactEmail: String(row.contact_email), assistantAnswer: String(row.assistant_answer || ""), status: String(row.status), staffReply: String(row.staff_reply || ""), repliedBy: String(row.replied_by || ""), repliedAt: String(row.replied_at || ""), createdAt: String(row.created_at) };
}
async function ownedProperty(landlordId: string, propertyId: string) {
  const row = rowsToObjects(await turso("SELECT id,name FROM hostel_properties WHERE id=? AND landlord_id=? LIMIT 1", [propertyId, landlordId]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That property is not in your workspace.", 404);
  return row;
}
export async function listHostelAiEntries(landlordId: string, propertyId: string) {
  await ensureHostelAiDeskTables();
  await ownedProperty(landlordId, propertyId);
  const rows = rowsToObjects(await turso(`SELECT e.*,COALESCE(r.label,'') AS room_label FROM hostel_ai_entries e
    LEFT JOIN hostel_rooms r ON r.id=e.room_id WHERE e.property_id=? AND e.status='ACTIVE'
    ORDER BY e.room_id,e.title COLLATE NOCASE LIMIT 80`, [propertyId]));
  return rows.map(entryView);
}
export async function saveHostelAiEntry(input: { landlordId: string; propertyId: string; id?: string; roomId?: string; title: unknown; content: unknown; actor: string }) {
  await ensureHostelAiDeskTables();
  await ownedProperty(input.landlordId, input.propertyId);
  const title = String(input.title || "").trim();
  const content = String(input.content || "").trim();
  const roomId = String(input.roomId || "").trim();
  if (title.length < 3 || title.length > 80 || content.length < 10 || content.length > 1500) throw new CampusEngineError("VALIDATION_ERROR", "Use a topic of 3–80 characters and information of 10–1,500 characters.", 400);
  if (roomId) {
    const room = rowsToObjects(await turso("SELECT id FROM hostel_rooms WHERE id=? AND property_id=? AND status='ACTIVE' LIMIT 1", [roomId, input.propertyId]))[0];
    if (!room) throw new CampusEngineError("NOT_FOUND", "Choose an active room in this property.", 404);
  }
  const stamp = new Date().toISOString();
  const id = String(input.id || "").trim();
  if (id) {
    const changed = await turso("UPDATE hostel_ai_entries SET room_id=?,title=?,content=?,updated_by=?,updated_at=? WHERE id=? AND property_id=? AND status='ACTIVE'", [roomId, title, content, input.actor, stamp, id, input.propertyId]);
    if (!Number(changed.affected_row_count)) throw new CampusEngineError("NOT_FOUND", "That information item was not found.", 404);
  } else {
    await turso("INSERT INTO hostel_ai_entries (id,property_id,room_id,title,content,status,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?,?)", [crypto.randomUUID(), input.propertyId, roomId, title, content, input.actor, stamp, stamp]);
  }
  await consoleAudit({ actor: input.actor, action: id ? "HOSTEL_AI_INFO_UPDATED" : "HOSTEL_AI_INFO_CREATED", targetType: "hostel_property", targetReference: input.propertyId, details: { title, roomId } }).catch(() => undefined);
  return listHostelAiEntries(input.landlordId, input.propertyId);
}
export async function archiveHostelAiEntry(input: { landlordId: string; propertyId: string; id: string; actor: string }) {
  await ensureHostelAiDeskTables();
  await ownedProperty(input.landlordId, input.propertyId);
  const result = await turso("UPDATE hostel_ai_entries SET status='ARCHIVED',updated_by=?,updated_at=? WHERE id=? AND property_id=? AND status='ACTIVE'", [input.actor, new Date().toISOString(), input.id, input.propertyId]);
  if (!Number(result.affected_row_count)) throw new CampusEngineError("NOT_FOUND", "That information item was not found.", 404);
  await consoleAudit({ actor: input.actor, action: "HOSTEL_AI_INFO_ARCHIVED", targetType: "hostel_ai_entry", targetReference: input.id, details: { propertyId: input.propertyId } }).catch(() => undefined);
  return listHostelAiEntries(input.landlordId, input.propertyId);
}
export async function listPublicHostelAiEntries(propertyId: string) {
  await ensureHostelAiDeskTables();
  const rows = rowsToObjects(await turso(`SELECT e.*,COALESCE(r.label,'') AS room_label FROM hostel_ai_entries e
    LEFT JOIN hostel_rooms r ON r.id=e.room_id WHERE e.property_id=? AND e.status='ACTIVE'
    AND (e.room_id='' OR r.status='ACTIVE') ORDER BY e.room_id,e.title COLLATE NOCASE LIMIT 40`, [propertyId]));
  return rows.map(entryView);
}
export async function createHostelAiInquiry(input: { propertyId?: unknown; question?: unknown; name?: unknown; email?: unknown; assistantAnswer?: unknown }) {
  const propertyId = String(input.propertyId || "").trim();
  const question = String(input.question || "").trim();
  const name = String(input.name || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  if (!propertyId || question.length < 10 || question.length > 500 || name.length < 2 || name.length > 100 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CampusEngineError("VALIDATION_ERROR", "Enter your name, email and a question of 10–500 characters.", 400);
  const publicProperty = await getPublicProperty(propertyId);
  if (!publicProperty) throw new CampusEngineError("NOT_FOUND", "That hostel is not publicly listed.", 404);
  await ensureHostelAiDeskTables();
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso("INSERT INTO hostel_ai_inquiries (id,property_id,question,contact_name,contact_email,assistant_answer,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'OPEN',?,?)", [id, propertyId, question, name, email, String(input.assistantAnswer || "").slice(0, 900), stamp, stamp]);
  return { id, status: "OPEN" };
}
export async function listHostelAiInquiries(landlordId: string, propertyId: string) {
  await ensureHostelAiDeskTables();
  await ownedProperty(landlordId, propertyId);
  const rows = rowsToObjects(await turso(`SELECT q.*,p.name AS property_name FROM hostel_ai_inquiries q
    JOIN hostel_properties p ON p.id=q.property_id WHERE q.property_id=? AND p.landlord_id=?
    ORDER BY CASE q.status WHEN 'OPEN' THEN 0 ELSE 1 END,q.created_at DESC LIMIT 100`, [propertyId, landlordId]));
  return rows.map(inquiryView);
}
export async function replyHostelAiInquiry(input: { landlordId: string; propertyId: string; id: string; reply: unknown; actor: string }) {
  await ensureHostelAiDeskTables();
  await ownedProperty(input.landlordId, input.propertyId);
  const reply = String(input.reply || "").trim();
  if (reply.length < 3 || reply.length > 2000) throw new CampusEngineError("VALIDATION_ERROR", "Write a reply of 3–2,000 characters.", 400);
  await ensureNotificationsTable();
  const stamp = new Date().toISOString();
  const updated = await turso("UPDATE hostel_ai_inquiries SET status='ANSWERED',staff_reply=?,replied_by=?,replied_at=?,updated_at=? WHERE id=? AND property_id=? AND status='OPEN'", [reply, input.actor, stamp, stamp, input.id, input.propertyId]);
  if (!Number(updated.affected_row_count)) throw new CampusEngineError("INVALID_STATE", "That inquiry was already answered or is no longer open.", 409);
  const row = rowsToObjects(await turso("SELECT contact_email,question FROM hostel_ai_inquiries WHERE id=? AND property_id=? LIMIT 1", [input.id, input.propertyId]))[0];
  const property = await ownedProperty(input.landlordId, input.propertyId);
  try {
    await queueNotification(turso, { recipient: String(row.contact_email), template: "hostel_ai_inquiry_reply", subject: `${String(property.name)} answered your hostel question`, message: `Your question: ${String(row.question)}\n\nReply from ${String(property.name)}: ${reply}`, reference: `hostel-ai-reply:${input.id}`, nowIso: stamp });
  } catch (error) {
    const queued = rowsToObjects(await turso("SELECT id FROM notification_outbox WHERE reference=? AND template='hostel_ai_inquiry_reply' LIMIT 1", [`hostel-ai-reply:${input.id}`]))[0];
    if (!queued) {
      await turso("UPDATE hostel_ai_inquiries SET status='OPEN',staff_reply='',replied_by='',replied_at='',updated_at=? WHERE id=? AND status='ANSWERED' AND replied_at=?", [new Date().toISOString(), input.id, stamp]);
      throw error;
    }
  }
  await consoleAudit({ actor: input.actor, action: "HOSTEL_AI_INQUIRY_REPLIED", targetType: "hostel_ai_inquiry", targetReference: input.id, details: { propertyId: input.propertyId } }).catch(() => undefined);
  return listHostelAiInquiries(input.landlordId, input.propertyId);
}
