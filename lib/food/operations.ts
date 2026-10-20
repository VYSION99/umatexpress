import { CampusEngineError } from "@/lib/campus-engine/errors";
import { ensureFoodDirectoryTables } from "@/lib/food/listings";
import { foodVendorForProfile } from "@/lib/food/vendors";
import { notifyParty } from "@/lib/notify-templates";
import type { StudentAccount } from "@/lib/student-auth";
import { rowsToObjects, runSchemaPass, turso, tursoReadBatch, tursoTransaction } from "@/lib/turso";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS food_pilot_settings (id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,support_contact TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS food_provider_operations (provider_id TEXT PRIMARY KEY,pilot_enabled INTEGER NOT NULL DEFAULT 0,service_status TEXT NOT NULL DEFAULT 'CLOSED',current_hours TEXT NOT NULL DEFAULT '',availability_note TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS food_operation_audit (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,actor_account_id TEXT NOT NULL,actor_email TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_food_operation_audit_provider ON food_operation_audit(provider_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS food_order_issues (id TEXT PRIMARY KEY,preorder_id TEXT NOT NULL,provider_id TEXT NOT NULL,student_id TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',assigned_to TEXT NOT NULL DEFAULT '',resolution_note TEXT NOT NULL DEFAULT '',resolved_by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,resolved_at TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_food_order_issues_queue ON food_order_issues(status,created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_food_order_issue_active ON food_order_issues(preorder_id) WHERE status IN ('OPEN','IN_REVIEW')`,
  `CREATE TABLE IF NOT EXISTS food_order_feedback (id TEXT PRIMARY KEY,preorder_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,student_id TEXT NOT NULL,rating INTEGER NOT NULL,comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_food_feedback_provider ON food_order_feedback(provider_id,created_at DESC)`,
];

let ready: Promise<void> | null = null;
export function ensureFoodOperationsTables() {
  ready ??= Promise.all([
    ensureFoodDirectoryTables(),
    runSchemaPass({ id: "food-operations", version: "1", statements: SCHEMA }),
  ]).then(() => undefined).catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

function clean(value: unknown, label: string, max: number, min = 0) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max) throw new CampusEngineError("VALIDATION_ERROR", `${label} must be between ${min} and ${max} characters.`, 400);
  return result;
}
function operationView(row?: Record<string, unknown>) {
  return {
    pilotEnabled: Number(row?.pilot_enabled || 0) === 1,
    serviceStatus: String(row?.service_status || "CLOSED") as "OPEN" | "BUSY" | "CLOSED",
    currentHours: String(row?.current_hours || ""),
    availabilityNote: String(row?.availability_note || ""),
    updatedAt: String(row?.updated_at || ""),
  };
}
export async function foodPilotSettings() {
  await ensureFoodOperationsTables();
  const row = rowsToObjects(await turso("SELECT * FROM food_pilot_settings WHERE id='GLOBAL' LIMIT 1"))[0];
  return { enabled: Number(row?.enabled || 0) === 1, supportContact: String(row?.support_contact || ""), updatedAt: String(row?.updated_at || "") };
}
export async function saveFoodPilotSettings(input: Record<string, unknown>, actor: string) {
  await ensureFoodOperationsTables();
  const now = new Date().toISOString();
  const enabled = input.enabled === true ? 1 : 0;
  const support = clean(input.supportContact, "Support contact", 180, enabled ? 3 : 0);
  await turso(`INSERT INTO food_pilot_settings (id,enabled,support_contact,updated_by,updated_at) VALUES ('GLOBAL',?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,support_contact=excluded.support_contact,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, [enabled,support,actor,now]);
  return { enabled: enabled === 1, supportContact: support, updatedAt: now };
}

export async function vendorFoodOperations(profileId: string) {
  await ensureFoodOperationsTables();
  const vendor = await foodVendorForProfile(profileId);
  if (vendor.status !== "ACTIVE" || !vendor.providerId) throw new CampusEngineError("INVALID_STATE", "Staff must link this account to a published provider first.", 409);
  const [providerResult, operationResult, menuResult, auditResult] = await tursoReadBatch([
    { sql: "SELECT id,name,hours,status FROM food_providers WHERE id=? LIMIT 1", args: [vendor.providerId] },
    { sql: "SELECT * FROM food_provider_operations WHERE provider_id=? LIMIT 1", args: [vendor.providerId] },
    { sql: "SELECT id,name,status,updated_at FROM food_menu_items WHERE provider_id=? ORDER BY display_order,created_at", args: [vendor.providerId] },
    { sql: "SELECT action,actor_email,created_at FROM food_operation_audit WHERE provider_id=? ORDER BY created_at DESC LIMIT 12", args: [vendor.providerId] },
  ]);
  const provider = rowsToObjects(providerResult)[0];
  if (!provider || String(provider.status) !== "PUBLISHED") throw new CampusEngineError("INVALID_STATE", "The linked provider must remain published.", 409);
  const operation = operationView(rowsToObjects(operationResult)[0]);
  return {
    provider: { id: String(provider.id), name: String(provider.name), verifiedHours: String(provider.hours) },
    operation: { ...operation, currentHours: operation.currentHours || String(provider.hours) },
    items: rowsToObjects(menuResult).map((item) => ({ id: String(item.id), name: String(item.name), available: String(item.status) === "LISTED", updatedAt: String(item.updated_at) })),
    audit: rowsToObjects(auditResult).map((item) => ({ action: String(item.action), actor: String(item.actor_email), createdAt: String(item.created_at) })),
  };
}

export async function saveVendorFoodOperations(profileId: string, actorAccountId: string, actorEmail: string, input: Record<string, unknown>) {
  await ensureFoodOperationsTables();
  const current = await vendorFoodOperations(profileId);
  const status = String(input.serviceStatus || "").toUpperCase();
  if (!["OPEN","BUSY","CLOSED"].includes(status)) throw new CampusEngineError("VALIDATION_ERROR", "Choose open, busy, or closed.", 400);
  const hours = clean(input.currentHours, "Current hours", 180, 3);
  const note = clean(input.availabilityNote, "Availability note", 240, status === "CLOSED" ? 3 : 0);
  const selected = Array.isArray(input.availableItemIds) ? input.availableItemIds.map(String) : [];
  const known = new Set(current.items.map((item) => item.id));
  if (selected.some((id) => !known.has(id))) throw new CampusEngineError("VALIDATION_ERROR", "One or more menu items are invalid.", 400);
  const now = new Date().toISOString();
  const before = JSON.stringify({ operation: current.operation, items: current.items.map(({ id, available }) => ({ id, available })) });
  const afterValue = { pilotEnabled: current.operation.pilotEnabled, serviceStatus: status, currentHours: hours, availabilityNote: note, items: current.items.map(({ id }) => ({ id, available: selected.includes(id) })) };
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [
    { sql: `INSERT INTO food_provider_operations (provider_id,pilot_enabled,service_status,current_hours,availability_note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET service_status=excluded.service_status,current_hours=excluded.current_hours,availability_note=excluded.availability_note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, args: [current.provider.id, current.operation.pilotEnabled ? 1 : 0, status, hours, note, actorEmail, now] },
  ];
  current.items.forEach((item) => statements.push({ sql: "UPDATE food_menu_items SET status=?,updated_at=? WHERE id=? AND provider_id=?", args: [selected.includes(item.id) ? "LISTED" : "UNAVAILABLE",now,item.id,current.provider.id] }));
  statements.push({ sql: "INSERT INTO food_operation_audit (id,provider_id,actor_account_id,actor_email,action,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)", args: [crypto.randomUUID(),current.provider.id,actorAccountId,actorEmail,"VENDOR_AVAILABILITY_UPDATE",before,JSON.stringify(afterValue),now] });
  await tursoTransaction(statements);
  return vendorFoodOperations(profileId);
}

export async function setProviderPilot(input: { providerId: unknown; enabled: unknown }, actor: string) {
  await ensureFoodOperationsTables();
  const providerId = clean(input.providerId, "Provider", 80, 1);
  const provider = rowsToObjects(await turso("SELECT id,hours,status FROM food_providers WHERE id=? LIMIT 1", [providerId]))[0];
  if (!provider || String(provider.status) !== "PUBLISHED") throw new CampusEngineError("INVALID_STATE", "Only a published provider can join the pilot.", 409);
  const enabled = input.enabled === true ? 1 : 0;
  if (enabled && !rowsToObjects(await turso("SELECT id FROM food_vendor_profiles WHERE provider_id=? AND status='ACTIVE' LIMIT 1", [providerId])).length) throw new CampusEngineError("INVALID_STATE", "Link an active vendor account before admitting this provider.", 409);
  const now = new Date().toISOString();
  await tursoTransaction([
    { sql: `INSERT INTO food_provider_operations (provider_id,pilot_enabled,service_status,current_hours,availability_note,updated_by,updated_at) VALUES (?,?, 'CLOSED',?,'',?,?) ON CONFLICT(provider_id) DO UPDATE SET pilot_enabled=excluded.pilot_enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, args: [providerId,enabled,String(provider.hours),actor,now] },
    { sql: "INSERT INTO food_operation_audit (id,provider_id,actor_account_id,actor_email,action,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)", args: [crypto.randomUUID(),providerId,"STAFF",actor,enabled ? "PILOT_ENABLED" : "PILOT_DISABLED","{}",JSON.stringify({ pilotEnabled: enabled === 1 }),now] },
  ]);
  return { providerId, pilotEnabled: enabled === 1 };
}

const ISSUE_CATEGORIES = ["LATE","MISSING_ITEM","INCORRECT_ITEM","QUALITY","PICKUP_PROBLEM","OTHER"];
export async function submitFoodCare(input: Record<string, unknown>, student: StudentAccount) {
  await ensureFoodOperationsTables();
  const preorderId = clean(input.preorderId, "Pickup request", 80, 1);
  const order = rowsToObjects(await turso("SELECT id,provider_id,status,pickup_at FROM food_preorders WHERE id=? AND student_id=? LIMIT 1", [preorderId,student.id]))[0];
  if (!order) throw new CampusEngineError("NOT_FOUND", "Pickup request not found.", 404);
  const action = String(input.action || "").toUpperCase();
  const now = new Date().toISOString();
  if (action === "FEEDBACK") {
    if (String(order.status) !== "COLLECTED") throw new CampusEngineError("INVALID_STATE", "Feedback opens after collection is confirmed.", 409);
    const rating = Math.round(Number(input.rating));
    if (rating < 1 || rating > 5) throw new CampusEngineError("VALIDATION_ERROR", "Choose a rating from 1 to 5.", 400);
    const comment = clean(input.message, "Feedback", 500);
    try {
      const id = crypto.randomUUID();
      await turso("INSERT INTO food_order_feedback (id,preorder_id,provider_id,student_id,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)", [id,preorderId,String(order.provider_id),student.id,rating,comment,now]);
      return { id, type: "FEEDBACK" };
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new CampusEngineError("CONFLICT", "Feedback has already been submitted for this pickup.", 409);
      throw error;
    }
  }
  if (action !== "ISSUE") throw new CampusEngineError("VALIDATION_ERROR", "Choose feedback or report a problem.", 400);
  if (!["ACCEPTED","READY","COLLECTED"].includes(String(order.status))) throw new CampusEngineError("INVALID_STATE", "Problems can be reported after the provider accepts a pickup.", 409);
  const category = String(input.category || "").toUpperCase();
  if (!ISSUE_CATEGORIES.includes(category)) throw new CampusEngineError("VALIDATION_ERROR", "Choose the type of pickup problem.", 400);
  const message = clean(input.message, "Problem details", 700, 10);
  try {
    const id = crypto.randomUUID();
    await turso("INSERT INTO food_order_issues (id,preorder_id,provider_id,student_id,category,message,status,created_at) VALUES (?,?,?,?,?,?,'OPEN',?)", [id,preorderId,String(order.provider_id),student.id,category,message,now]);
    const support = await foodPilotSettings();
    if (support.supportContact.includes("@")) void notifyParty({ recipient: support.supportContact, reference: id, notice: { template: "food_support_opened", subject: "New Food pickup support case", message: `A student opened a ${category.replaceAll("_"," ").toLowerCase()} case for a pickup. Review it in the Food operations console.` } });
    return { id, type: "ISSUE" };
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new CampusEngineError("CONFLICT", "This pickup already has an active support case.", 409);
    throw error;
  }
}

export async function foodOperationsDashboard() {
  await ensureFoodOperationsTables();
  const [issuesResult, metricsResult, feedbackResult, providersResult, auditResult] = await tursoReadBatch([
    { sql: `SELECT i.*,o.reference,o.student_name,o.student_email,p.name AS provider_name FROM food_order_issues i JOIN food_preorders o ON o.id=i.preorder_id JOIN food_providers p ON p.id=i.provider_id ORDER BY CASE i.status WHEN 'OPEN' THEN 0 WHEN 'IN_REVIEW' THEN 1 ELSE 2 END,i.created_at DESC LIMIT 150`, args: [] },
    { sql: `SELECT p.id,p.name,COUNT(o.id) AS total_orders,SUM(CASE WHEN o.status='COLLECTED' THEN 1 ELSE 0 END) AS collected,SUM(CASE WHEN o.status='EXPIRED' THEN 1 ELSE 0 END) AS expired,SUM(CASE WHEN o.status='DECLINED' THEN 1 ELSE 0 END) AS declined,AVG(CASE WHEN o.accepted_at<>'' THEN (julianday(o.accepted_at)-julianday(o.created_at))*1440 END) AS average_response_minutes FROM food_providers p LEFT JOIN food_preorders o ON o.provider_id=p.id GROUP BY p.id,p.name ORDER BY p.name`, args: [] },
    { sql: "SELECT provider_id,COUNT(*) AS feedback_count,AVG(rating) AS average_rating FROM food_order_feedback GROUP BY provider_id", args: [] },
    { sql: "SELECT p.id,p.name,p.status,COALESCE(o.pilot_enabled,0) AS pilot_enabled,COALESCE(o.service_status,'CLOSED') AS service_status,o.updated_at FROM food_providers p LEFT JOIN food_provider_operations o ON o.provider_id=p.id ORDER BY p.name", args: [] },
    { sql: "SELECT a.provider_id,p.name AS provider_name,a.action,a.actor_email,a.created_at FROM food_operation_audit a JOIN food_providers p ON p.id=a.provider_id ORDER BY a.created_at DESC LIMIT 40", args: [] },
  ]);
  const feedback = new Map(rowsToObjects(feedbackResult).map((row) => [String(row.provider_id), row]));
  return {
    pilot: await foodPilotSettings(),
    issues: rowsToObjects(issuesResult),
    metrics: rowsToObjects(metricsResult).map((row) => ({ providerId:String(row.id),providerName:String(row.name),total:Number(row.total_orders||0),completed:Number(row.collected||0),expired:Number(row.expired||0),declined:Number(row.declined||0),averageResponseMinutes:row.average_response_minutes==null?null:Number(row.average_response_minutes),feedbackCount:Number(feedback.get(String(row.id))?.feedback_count||0),averageRating:feedback.get(String(row.id))?.average_rating==null?null:Number(feedback.get(String(row.id))?.average_rating) })),
    providers: rowsToObjects(providersResult).map((row) => ({ id:String(row.id),name:String(row.name),status:String(row.status),pilotEnabled:Number(row.pilot_enabled||0)===1,serviceStatus:String(row.service_status||"CLOSED"),updatedAt:String(row.updated_at||"") })),
    audit: rowsToObjects(auditResult),
  };
}

export async function resolveFoodIssue(input: Record<string, unknown>, actor: string) {
  await ensureFoodOperationsTables();
  const id = clean(input.id, "Support case", 80, 1);
  const action = String(input.action || "").toUpperCase();
  if (!["REVIEW","RESOLVE","DISMISS"].includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose review, resolve, or dismiss.", 400);
  const note = clean(input.note, "Resolution note", 600, action === "REVIEW" ? 0 : 10);
  const status = action === "REVIEW" ? "IN_REVIEW" : action === "RESOLVE" ? "RESOLVED" : "DISMISSED";
  const now = new Date().toISOString();
  const caseRow = rowsToObjects(await turso(`SELECT i.id,o.student_email,o.reference,p.name AS provider_name FROM food_order_issues i JOIN food_preorders o ON o.id=i.preorder_id JOIN food_providers p ON p.id=i.provider_id WHERE i.id=? AND i.status IN ('OPEN','IN_REVIEW') LIMIT 1`, [id]))[0];
  if (!caseRow) throw new CampusEngineError("NOT_FOUND", "Active support case not found.", 404);
  const result = await turso("UPDATE food_order_issues SET status=?,assigned_to=?,resolution_note=?,resolved_by=?,resolved_at=? WHERE id=? AND status IN ('OPEN','IN_REVIEW')", [status,actor,note,action === "REVIEW" ? "" : actor,action === "REVIEW" ? "" : now,id]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("NOT_FOUND", "Active support case not found.", 404);
  if (action !== "REVIEW") void notifyParty({ recipient: String(caseRow.student_email), reference: String(caseRow.reference), notice: { template: "food_support_closed", subject: `Food pickup case ${status.toLowerCase()}`, message: `Your support case for ${String(caseRow.provider_name)} was ${status.toLowerCase()}. Staff note: ${note}` } });
  return { id, status };
}
