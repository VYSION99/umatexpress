import { CampusEngineError } from "@/lib/campus-engine/errors";
import type { StudentAccount } from "@/lib/student-auth";
import { notifyParty } from "@/lib/notify-templates";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";
import { PRINT_COPY_QUOTE_RETENTION_DAYS, PRINT_COPY_VERIFICATION_DAYS } from "./constants";

function verificationCutoff(now = Date.now()) { return new Date(now - PRINT_COPY_VERIFICATION_DAYS * 24 * 60 * 60_000).toISOString(); }

export type PrintCopyProvider = {
  id: string; name: string; description: string; location: string; contactLabel: string; contactHref: string;
  hours: string; services: string[]; indicativePricing: string; turnaround: string; updatedAt: string; verifiedAt: string;
};
export type PrintCopyProviderRecord = PrintCopyProvider & {
  status: "DRAFT" | "PUBLISHED" | "SUSPENDED"; verificationNote: string; verifiedBy: string; createdAt: string;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS print_copy_providers (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',location TEXT NOT NULL,contact_label TEXT NOT NULL,contact_href TEXT NOT NULL,hours TEXT NOT NULL,services_json TEXT NOT NULL DEFAULT '[]',indicative_pricing TEXT NOT NULL DEFAULT '',turnaround TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'DRAFT',verification_note TEXT NOT NULL DEFAULT '',verified_by TEXT NOT NULL DEFAULT '',verified_at TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_print_copy_providers_public ON print_copy_providers(status,verified_at,updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS print_copy_settings (id TEXT PRIMARY KEY,quotes_enabled INTEGER NOT NULL DEFAULT 0,support_owner TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS print_copy_quotes (id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,student_id TEXT NOT NULL,student_name TEXT NOT NULL,student_email TEXT NOT NULL,requirements TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'NEW',staff_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(provider_id) REFERENCES print_copy_providers(id) ON DELETE RESTRICT)`,
  `CREATE INDEX IF NOT EXISTS idx_print_copy_quotes_queue ON print_copy_quotes(status,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_print_copy_quotes_student ON print_copy_quotes(student_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_print_copy_quotes_expiry ON print_copy_quotes(expires_at)`,
  `CREATE TABLE IF NOT EXISTS print_copy_listing_reports (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',resolved_by TEXT NOT NULL DEFAULT '',resolution_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,resolved_at TEXT NOT NULL DEFAULT '',FOREIGN KEY(provider_id) REFERENCES print_copy_providers(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_print_copy_reports_queue ON print_copy_listing_reports(status,created_at DESC)`,
];
let schemaReady: Promise<void> | null = null;
export function ensurePrintCopyTables() {
  schemaReady ??= runSchemaPass({ id: "print-copy-directory", version: "2", statements: SCHEMA }).catch((error: unknown) => { schemaReady = null; throw error; });
  return schemaReady;
}

function clean(value: unknown, label: string, max: number, min = 1) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max) throw new CampusEngineError("VALIDATION_ERROR", `${label} must be between ${min} and ${max} characters.`, 400);
  return result;
}
function contact(value: unknown) {
  const href = clean(value, "Contact link", 300);
  let secureHttps = false;
  try { const parsed = new URL(href); secureHttps = parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password; } catch { /* checked below */ }
  if (!secureHttps && !/^tel:\+?[0-9][0-9 .()-]{5,24}$/.test(href)) throw new CampusEngineError("VALIDATION_ERROR", "Use a secure https or valid telephone contact link.", 400);
  return href;
}
function providerView(row: Record<string, unknown>): PrintCopyProviderRecord {
  let services: string[] = [];
  try { const parsed: unknown = JSON.parse(String(row.services_json || "[]")); if (Array.isArray(parsed)) services = parsed.filter((value): value is string => typeof value === "string").slice(0, 20); } catch { /* malformed legacy data displays no services */ }
  return {
    id: String(row.id), name: String(row.name), description: String(row.description || ""), location: String(row.location),
    contactLabel: String(row.contact_label), contactHref: String(row.contact_href), hours: String(row.hours), services,
    indicativePricing: String(row.indicative_pricing || ""), turnaround: String(row.turnaround || ""), updatedAt: String(row.updated_at),
    verifiedAt: String(row.verified_at || ""), status: String(row.status) as PrintCopyProviderRecord["status"],
    verificationNote: String(row.verification_note || ""), verifiedBy: String(row.verified_by || ""), createdAt: String(row.created_at),
  };
}
async function providerRows(where = "", args: Array<string | number | null> = []) {
  await ensurePrintCopyTables();
  return rowsToObjects(await turso(`SELECT * FROM print_copy_providers ${where} ORDER BY updated_at DESC`, args)).map(providerView);
}
export async function listPublicPrintCopyProviders(): Promise<PrintCopyProvider[]> {
  return (await providerRows("WHERE status='PUBLISHED' AND verified_at>=?", [verificationCutoff()])).map(({ id,name,description,location,contactLabel,contactHref,hours,services,indicativePricing,turnaround,updatedAt,verifiedAt }) => ({ id,name,description,location,contactLabel,contactHref,hours,services,indicativePricing,turnaround,updatedAt,verifiedAt }));
}
export function listPrintCopyProvidersForStaff() { return providerRows(); }

export async function getPrintCopyQuoteSettings() {
  await ensurePrintCopyTables();
  const row = rowsToObjects(await turso("SELECT quotes_enabled,support_owner,updated_at FROM print_copy_settings WHERE id='GLOBAL' LIMIT 1"))[0];
  return { enabled: Number(row?.quotes_enabled || 0) === 1, supportOwner: String(row?.support_owner || ""), updatedAt: String(row?.updated_at || "") };
}
export async function setPrintCopyQuoteSettings(input: { enabled: unknown; supportOwner: unknown }, actor: string) {
  await ensurePrintCopyTables();
  if (typeof input.enabled !== "boolean") throw new CampusEngineError("VALIDATION_ERROR", "Choose whether quote requests are open.", 400);
  const supportOwner = clean(input.supportOwner, "Support owner", 120, input.enabled ? 10 : 0);
  if (input.enabled && !rowsToObjects(await turso("SELECT id FROM print_copy_providers WHERE status='PUBLISHED' AND verified_at>=? LIMIT 1", [verificationCutoff()])).length) throw new CampusEngineError("INVALID_STATE", "Reverify and publish a shop before opening quote requests.", 409);
  const now = new Date().toISOString();
  await turso("INSERT INTO print_copy_settings(id,quotes_enabled,support_owner,updated_by,updated_at) VALUES ('GLOBAL',?,?,?,?) ON CONFLICT(id) DO UPDATE SET quotes_enabled=excluded.quotes_enabled,support_owner=excluded.support_owner,updated_by=excluded.updated_by,updated_at=excluded.updated_at", [input.enabled ? 1 : 0,supportOwner,actor,now]);
  return getPrintCopyQuoteSettings();
}

export async function savePrintCopyProvider(input: Record<string, unknown>, actor: string) {
  await ensurePrintCopyTables();
  const id = input.id ? clean(input.id, "Shop", 80) : crypto.randomUUID();
  const existing = rowsToObjects(await turso("SELECT id FROM print_copy_providers WHERE id=? LIMIT 1", [id]))[0];
  if (!Array.isArray(input.services) || input.services.length > 20) throw new CampusEngineError("VALIDATION_ERROR", "Add no more than 20 services.", 400);
  const services = input.services.map((value, index) => clean(value, `Service ${index + 1}`, 100));
  const fields = {
    name: clean(input.name, "Shop name", 120), description: clean(input.description, "Description", 500, 0),
    location: clean(input.location, "Location", 240), contactLabel: clean(input.contactLabel, "Contact label", 80),
    contactHref: contact(input.contactHref), hours: clean(input.hours, "Opening hours", 180),
    indicativePricing: clean(input.indicativePricing, "Indicative pricing", 500, 0), turnaround: clean(input.turnaround, "Typical turnaround", 180, 0),
  };
  const now = new Date().toISOString();
  const statement = existing
    ? { sql: "UPDATE print_copy_providers SET name=?,description=?,location=?,contact_label=?,contact_href=?,hours=?,services_json=?,indicative_pricing=?,turnaround=?,status='DRAFT',verification_note='',verified_by='',verified_at='',updated_at=? WHERE id=?", args: [fields.name,fields.description,fields.location,fields.contactLabel,fields.contactHref,fields.hours,JSON.stringify(services),fields.indicativePricing,fields.turnaround,now,id] as Array<string | number | null> }
    : { sql: "INSERT INTO print_copy_providers (id,name,description,location,contact_label,contact_href,hours,services_json,indicative_pricing,turnaround,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)", args: [id,fields.name,fields.description,fields.location,fields.contactLabel,fields.contactHref,fields.hours,JSON.stringify(services),fields.indicativePricing,fields.turnaround,actor,now,now] as Array<string | number | null> };
  await turso(statement.sql, statement.args);
  return (await providerRows("WHERE id=?", [id]))[0];
}
export async function decidePrintCopyProvider(input: { id: unknown; action: unknown; note: unknown }, actor: string) {
  await ensurePrintCopyTables();
  const id = clean(input.id, "Shop", 80); const action = String(input.action || "").toUpperCase();
  const note = clean(input.note, action === "PUBLISH" ? "Verification note" : "Decision note", 500, 10);
  const provider = rowsToObjects(await turso("SELECT id,services_json,indicative_pricing,turnaround FROM print_copy_providers WHERE id=? LIMIT 1", [id]))[0];
  if (!provider) throw new CampusEngineError("NOT_FOUND", "Print & Copy provider not found.", 404);
  const now = new Date().toISOString();
  if (action === "PUBLISH") {
    let services: unknown = [];
    try { services = JSON.parse(String(provider.services_json || "[]")); } catch { /* missing services remain unpublished */ }
    if (!Array.isArray(services) || services.length === 0 || !String(provider.indicative_pricing || "").trim() || !String(provider.turnaround || "").trim()) throw new CampusEngineError("INVALID_STATE", "Add confirmed services, indicative pricing and turnaround before publishing.", 409);
    await turso("UPDATE print_copy_providers SET status='PUBLISHED',verification_note=?,verified_by=?,verified_at=?,updated_at=? WHERE id=?", [note,actor,now,now,id]);
  }
  else if (action === "SUSPEND") await turso("UPDATE print_copy_providers SET status='SUSPENDED',verification_note=?,updated_at=? WHERE id=?", [note,now,id]);
  else throw new CampusEngineError("VALIDATION_ERROR", "Choose publish or suspend.", 400);
  return (await providerRows("WHERE id=?", [id]))[0];
}

function reference() { return `PC-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`; }
export async function createPrintCopyQuote(input: { providerId: unknown; requirements: unknown }, student: StudentAccount) {
  await ensurePrintCopyTables();
  const providerId = clean(input.providerId, "Shop", 80);
  const requirements = clean(input.requirements, "Job description", 1000, 20);
  const id = crypto.randomUUID(); const code = reference(); const now = new Date(); const expiresAt = new Date(now.getTime() + PRINT_COPY_QUOTE_RETENTION_DAYS * 24 * 60 * 60_000).toISOString(); const stamp = now.toISOString();
  // Both gates are checked in the same atomic statement as the insert.
  const inserted = await turso("INSERT INTO print_copy_quotes (id,reference,provider_id,student_id,student_name,student_email,requirements,status,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,?,?,'NEW',?,?,? WHERE EXISTS (SELECT 1 FROM print_copy_settings WHERE id='GLOBAL' AND quotes_enabled=1) AND EXISTS (SELECT 1 FROM print_copy_providers WHERE id=? AND status='PUBLISHED' AND verified_at>=?)", [id,code,providerId,student.id,student.name,student.email,requirements,stamp,stamp,expiresAt,providerId,verificationCutoff(now.getTime())]);
  if (Number(inserted.affected_row_count || 0) !== 1) {
    if (!(await getPrintCopyQuoteSettings()).enabled) throw new CampusEngineError("INVALID_STATE", "Quote requests are not open yet. Contact the shop directly.", 409);
    throw new CampusEngineError("NOT_FOUND", "That verified print shop is not available.", 404);
  }
  return { reference: code };
}
export async function purgeExpiredPrintCopyQuotes() {
  if (!(await isTursoConfiguredRuntime())) return 0;
  await ensurePrintCopyTables();
  const result = await turso("DELETE FROM print_copy_quotes WHERE expires_at<=?", [new Date().toISOString()]);
  return Number(result.affected_row_count || 0);
}
export async function listStudentPrintCopyQuotes(studentId: string) {
  await ensurePrintCopyTables();
  return rowsToObjects(await turso("SELECT q.reference,p.name AS provider_name,q.status,q.created_at,q.updated_at,q.expires_at FROM print_copy_quotes q JOIN print_copy_providers p ON p.id=q.provider_id WHERE q.student_id=? AND q.expires_at>? ORDER BY q.created_at DESC LIMIT 50", [studentId,new Date().toISOString()]));
}
export async function listPrintCopyQuotes() {
  await ensurePrintCopyTables();
  const now = new Date().toISOString();
  return rowsToObjects(await turso("SELECT q.id,q.reference,q.provider_id,p.name AS provider_name,q.student_name,q.student_email,q.requirements,q.status,q.staff_note,q.created_at,q.updated_at FROM print_copy_quotes q JOIN print_copy_providers p ON p.id=q.provider_id WHERE q.expires_at>? ORDER BY CASE q.status WHEN 'NEW' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,q.created_at DESC LIMIT 300", [now]));
}
const QUOTE_STATUS_ORDER: Record<string, number> = { NEW: 0, IN_PROGRESS: 1, CLOSED: 2 };
export async function updatePrintCopyQuote(input: { id: unknown; status: unknown; staffNote: unknown }) {
  await ensurePrintCopyTables();
  const id = clean(input.id, "Quote request", 80); const status = String(input.status || "").toUpperCase();
  if (!(["NEW","IN_PROGRESS","CLOSED"] as string[]).includes(status)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid quote status.", 400);
  const staffNote = clean(input.staffNote, "Staff note", 500, status === "CLOSED" ? 10 : 0); const now = new Date().toISOString();
  const before = rowsToObjects(await turso("SELECT status,reference,student_email FROM print_copy_quotes WHERE id=? AND expires_at>? LIMIT 1", [id,now]))[0];
  if (!before) throw new CampusEngineError("NOT_FOUND", "Quote request not found.", 404);
  const nextOrder = QUOTE_STATUS_ORDER[status] ?? -1; const prevOrder = QUOTE_STATUS_ORDER[String(before.status)] ?? -1;
  if (nextOrder !== prevOrder + 1 && nextOrder !== prevOrder) throw new CampusEngineError("INVALID_STATE", "Quote status can only move forward one step: NEW → IN_PROGRESS → CLOSED.", 409);
  const result = await turso("UPDATE print_copy_quotes SET status=?,staff_note=?,updated_at=? WHERE id=? AND status=? AND expires_at>?", [status,staffNote,now,id,String(before.status),now]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("NOT_FOUND", "Quote request not found.", 404);
  if (String(before.status) !== status) {
    const label = status === "IN_PROGRESS" ? "in progress" : status === "CLOSED" ? "closed" : "reopened";
    await notifyParty({ recipient: before.student_email, reference: `${String(before.reference)}:${now}`, notice: { template: `print_copy_quote_${status.toLowerCase()}`, subject: `Print & Copy request ${String(before.reference)} ${label}`, message: `Your Print & Copy request ${String(before.reference)} is ${label}. View its status on the Print & Copy page. Staff will contact you using your student account email if more information is needed.` } });
  }
  return { id,status };
}

export async function reportPrintCopyListing(input: { providerId: unknown; category: unknown; message: unknown }) {
  await ensurePrintCopyTables();
  const providerId = clean(input.providerId, "Shop", 80); const category = String(input.category || "OTHER").toUpperCase();
  if (!["HOURS","SERVICES","PRICE","LOCATION","CONTACT","OTHER"].includes(category)) throw new CampusEngineError("VALIDATION_ERROR", "Choose what needs correcting.", 400);
  const message = clean(input.message, "Report", 600, 10);
  if (!rowsToObjects(await turso("SELECT id FROM print_copy_providers WHERE id=? AND status='PUBLISHED' LIMIT 1", [providerId])).length) throw new CampusEngineError("NOT_FOUND", "That published shop was not found.", 404);
  const id = crypto.randomUUID();
  await turso("INSERT INTO print_copy_listing_reports (id,provider_id,category,message,status,created_at) VALUES (?,?,?,?,'OPEN',?)", [id,providerId,category,message,new Date().toISOString()]);
  return { id };
}
export async function listPrintCopyReports() {
  await ensurePrintCopyTables();
  return rowsToObjects(await turso("SELECT r.id,r.provider_id,p.name AS provider_name,r.category,r.message,r.status,r.created_at,r.resolution_note FROM print_copy_listing_reports r JOIN print_copy_providers p ON p.id=r.provider_id ORDER BY CASE r.status WHEN 'OPEN' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 300"));
}
export async function resolvePrintCopyReport(input: { id: unknown; action: unknown; note: unknown }, actor: string) {
  await ensurePrintCopyTables();
  const id = clean(input.id, "Report", 80); const action = String(input.action || "").toUpperCase();
  if (!(["RESOLVE","DISMISS"] as string[]).includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose resolve or dismiss.", 400);
  const now = new Date().toISOString();
  const result = await turso("UPDATE print_copy_listing_reports SET status=?,resolved_by=?,resolution_note=?,resolved_at=? WHERE id=? AND status='OPEN'", [action === "RESOLVE" ? "RESOLVED" : "DISMISSED",actor,clean(input.note,"Resolution note",500,5),now,id]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("NOT_FOUND", "Open report not found.", 404);
  return { id,status:action === "RESOLVE" ? "RESOLVED" : "DISMISSED" };
}
