import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, runSchemaPass, turso, tursoReadBatch, tursoTransaction } from "@/lib/turso";

export type FoodMenuItem = { id: string; name: string; description: string; priceGhs: number; dietaryNote: string; updatedAt: string };
export type FoodListing = {
  id: string; name: string; description: string; location: string; contactLabel: string; contactHref: string;
  hours: string; pickupDetails: string; menuItems: FoodMenuItem[]; updatedAt: string; verifiedAt: string; lastConfirmedAt: string;
  preorder: { enabled: boolean; minimumLeadMinutes: number; maximumDaysAhead: number; dailyOrderLimit: number; responseMinutes: number; cancellationMinutes: number; pickupInstructions: string };
};
export type FoodProviderRecord = FoodListing & {
  status: "DRAFT" | "PUBLISHED" | "SUSPENDED"; verificationNote: string; verifiedBy: string; createdAt: string;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS food_providers (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',location TEXT NOT NULL,contact_label TEXT NOT NULL,contact_href TEXT NOT NULL,hours TEXT NOT NULL,pickup_details TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'DRAFT',verification_note TEXT NOT NULL DEFAULT '',verified_by TEXT NOT NULL DEFAULT '',verified_at TEXT NOT NULL DEFAULT '',last_confirmed_at TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_food_providers_public ON food_providers(status,verified_at,updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS food_menu_items (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price_pesewas INTEGER NOT NULL,dietary_note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'LISTED',display_order INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_food_menu_provider ON food_menu_items(provider_id,status,display_order,created_at)`,
  `CREATE TABLE IF NOT EXISTS food_listing_reports (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',resolved_by TEXT NOT NULL DEFAULT '',resolution_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,resolved_at TEXT NOT NULL DEFAULT '',FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_food_reports_queue ON food_listing_reports(status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS food_preorder_settings (provider_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,minimum_lead_minutes INTEGER NOT NULL DEFAULT 60,maximum_days_ahead INTEGER NOT NULL DEFAULT 3,daily_order_limit INTEGER NOT NULL DEFAULT 20,response_minutes INTEGER NOT NULL DEFAULT 20,cancellation_minutes INTEGER NOT NULL DEFAULT 30,pickup_instructions TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)`,
];

let schemaReady: Promise<void> | null = null;
export function ensureFoodDirectoryTables() {
  schemaReady ??= runSchemaPass({ id: "food-directory", version: "2", statements: SCHEMA }).catch((error: unknown) => { schemaReady = null; throw error; });
  return schemaReady;
}

function clean(value: unknown, label: string, max: number, min = 1) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max) throw new CampusEngineError("VALIDATION_ERROR", `${label} must be between ${min} and ${max} characters.`, 400);
  return result;
}
function validContact(value: unknown) {
  const href = clean(value, "Contact link", 300);
  if (!href.startsWith("https://") && !href.startsWith("tel:")) throw new CampusEngineError("VALIDATION_ERROR", "Use a secure https or telephone contact link.", 400);
  return href;
}
function parseMenu(value: unknown) {
  if (!Array.isArray(value) || value.length > 80) throw new CampusEngineError("VALIDATION_ERROR", "Add no more than 80 menu items.", 400);
  return value.map((raw, index) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const priceGhs = Number(item.priceGhs);
    if (!Number.isFinite(priceGhs) || priceGhs < 0 || priceGhs > 100000) throw new CampusEngineError("VALIDATION_ERROR", `Enter a valid price for menu item ${index + 1}.`, 400);
    return { id: String(item.id || crypto.randomUUID()), name: clean(item.name, `Menu item ${index + 1} name`, 100), description: clean(item.description, `Menu item ${index + 1} description`, 240, 0), dietaryNote: clean(item.dietaryNote, `Menu item ${index + 1} dietary note`, 160, 0), pricePesewas: Math.round(priceGhs * 100) };
  });
}
function providerView(row: Record<string, unknown>, items: Record<string, unknown>[], settings: Record<string, unknown>[]): FoodProviderRecord {
  const setting = settings.find((entry) => String(entry.provider_id) === String(row.id));
  return {
    id: String(row.id), name: String(row.name), description: String(row.description || ""), location: String(row.location),
    contactLabel: String(row.contact_label), contactHref: String(row.contact_href), hours: String(row.hours), pickupDetails: String(row.pickup_details || ""),
    status: String(row.status) as FoodProviderRecord["status"], verificationNote: String(row.verification_note || ""), verifiedBy: String(row.verified_by || ""),
    verifiedAt: String(row.verified_at || ""), lastConfirmedAt: String(row.last_confirmed_at || ""), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    menuItems: items.filter((item) => String(item.provider_id) === String(row.id)).map((item) => ({ id: String(item.id), name: String(item.name), description: String(item.description || ""), priceGhs: Number(item.price_pesewas) / 100, dietaryNote: String(item.dietary_note || ""), updatedAt: String(item.updated_at) })),
    preorder: { enabled: Number(setting?.enabled || 0) === 1, minimumLeadMinutes: Number(setting?.minimum_lead_minutes || 60), maximumDaysAhead: Number(setting?.maximum_days_ahead || 3), dailyOrderLimit: Number(setting?.daily_order_limit || 20), responseMinutes: Number(setting?.response_minutes || 20), cancellationMinutes: Number(setting?.cancellation_minutes || 30), pickupInstructions: String(setting?.pickup_instructions || "") },
  };
}
async function providerRows(where = "", args: Array<string | number | null> = []) {
  await ensureFoodDirectoryTables();
  const [providers, menu, settings] = await tursoReadBatch([
    { sql: `SELECT * FROM food_providers ${where} ORDER BY updated_at DESC`, args },
    { sql: `SELECT * FROM food_menu_items WHERE status='LISTED' ORDER BY display_order,created_at`, args: [] },
    { sql: `SELECT * FROM food_preorder_settings`, args: [] },
  ]);
  const items = rowsToObjects(menu);
  return rowsToObjects(providers).map((row) => providerView(row, items, rowsToObjects(settings)));
}

export async function listPublicFoodListings(): Promise<FoodListing[]> {
  return (await providerRows("WHERE status='PUBLISHED' AND verified_at<>''")).map(({ status: _status, verificationNote: _note, verifiedBy: _by, createdAt: _created, ...listing }) => listing);
}
export async function listFoodProvidersForStaff() { return providerRows(); }

export async function saveFoodProvider(input: Record<string, unknown>, actor: string) {
  await ensureFoodDirectoryTables();
  const id = String(input.id || crypto.randomUUID()).trim();
  const existing = rowsToObjects(await turso("SELECT id FROM food_providers WHERE id=? LIMIT 1", [id]))[0];
  const now = new Date().toISOString();
  const menu = parseMenu(input.menuItems);
  const fields = { name: clean(input.name, "Provider name", 120), description: clean(input.description, "Description", 500, 0), location: clean(input.location, "Location", 240), contactLabel: clean(input.contactLabel, "Contact label", 80), contactHref: validContact(input.contactHref), hours: clean(input.hours, "Opening hours", 180), pickupDetails: clean(input.pickupDetails, "Pickup details", 240, 0) };
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = existing ? [{ sql: "UPDATE food_providers SET name=?,description=?,location=?,contact_label=?,contact_href=?,hours=?,pickup_details=?,status='DRAFT',verification_note='',verified_by='',verified_at='',last_confirmed_at='',updated_at=? WHERE id=?", args: [fields.name,fields.description,fields.location,fields.contactLabel,fields.contactHref,fields.hours,fields.pickupDetails,now,id] }] : [{ sql: "INSERT INTO food_providers (id,name,description,location,contact_label,contact_href,hours,pickup_details,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'DRAFT',?,?,?)", args: [id,fields.name,fields.description,fields.location,fields.contactLabel,fields.contactHref,fields.hours,fields.pickupDetails,actor,now,now] }];
  statements.push({ sql: "DELETE FROM food_menu_items WHERE provider_id=?", args: [id] });
  menu.forEach((item, index) => statements.push({ sql: "INSERT INTO food_menu_items (id,provider_id,name,description,price_pesewas,dietary_note,status,display_order,created_at,updated_at) VALUES (?,?,?,?,?,?,'LISTED',?,?,?)", args: [item.id,id,item.name,item.description,item.pricePesewas,item.dietaryNote,index,now,now] }));
  await tursoTransaction(statements);
  return (await providerRows("WHERE id=?", [id]))[0];
}

export async function decideFoodProvider(input: { id: unknown; action: unknown; note: unknown }, actor: string) {
  await ensureFoodDirectoryTables();
  const id = clean(input.id, "Provider", 80); const action = String(input.action || "").toUpperCase();
  const note = clean(input.note, action === "PUBLISH" ? "Verification note" : "Decision note", 500, 10);
  if (!rowsToObjects(await turso("SELECT id FROM food_providers WHERE id=? LIMIT 1", [id])).length) throw new CampusEngineError("NOT_FOUND", "Food provider not found.", 404);
  const now = new Date().toISOString();
  if (action === "PUBLISH") {
    if (!rowsToObjects(await turso("SELECT id FROM food_menu_items WHERE provider_id=? AND status='LISTED' LIMIT 1", [id])).length) throw new CampusEngineError("INVALID_STATE", "Add at least one menu item before publishing.", 409);
    await turso("UPDATE food_providers SET status='PUBLISHED',verification_note=?,verified_by=?,verified_at=?,last_confirmed_at=?,updated_at=? WHERE id=?", [note,actor,now,now,now,id]);
  } else if (action === "SUSPEND") await turso("UPDATE food_providers SET status='SUSPENDED',verification_note=?,updated_at=? WHERE id=?", [note,now,id]);
  else throw new CampusEngineError("VALIDATION_ERROR", "Choose publish or suspend.", 400);
  return (await providerRows("WHERE id=?", [id]))[0];
}

export async function reportFoodListing(input: { providerId: unknown; category: unknown; message: unknown }) {
  await ensureFoodDirectoryTables();
  const providerId = clean(input.providerId, "Provider", 80); const category = String(input.category || "OTHER").toUpperCase();
  if (!["HOURS","MENU","PRICE","LOCATION","CONTACT","OTHER"].includes(category)) throw new CampusEngineError("VALIDATION_ERROR", "Choose what needs correcting.", 400);
  const message = clean(input.message, "Report", 600, 10);
  if (!rowsToObjects(await turso("SELECT id FROM food_providers WHERE id=? AND status='PUBLISHED' LIMIT 1", [providerId])).length) throw new CampusEngineError("NOT_FOUND", "That published food listing was not found.", 404);
  const id = crypto.randomUUID();
  await turso("INSERT INTO food_listing_reports (id,provider_id,category,message,status,created_at) VALUES (?,?,?,?,'OPEN',?)", [id,providerId,category,message,new Date().toISOString()]);
  return { id };
}
export async function listFoodReports() {
  await ensureFoodDirectoryTables();
  return rowsToObjects(await turso(`SELECT r.id,r.provider_id,p.name AS provider_name,r.category,r.message,r.status,r.created_at,r.resolution_note,r.resolved_at FROM food_listing_reports r JOIN food_providers p ON p.id=r.provider_id ORDER BY CASE r.status WHEN 'OPEN' THEN 0 ELSE 1 END,r.created_at DESC`));
}
export async function resolveFoodReport(input: { id: unknown; action: unknown; note: unknown }, actor: string) {
  await ensureFoodDirectoryTables();
  const id = clean(input.id, "Report", 80); const action = String(input.action || "").toUpperCase();
  if (!["RESOLVE","DISMISS"].includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose resolve or dismiss.", 400);
  const result = await turso("UPDATE food_listing_reports SET status=?,resolved_by=?,resolution_note=?,resolved_at=? WHERE id=? AND status='OPEN'", [action === "RESOLVE" ? "RESOLVED" : "DISMISSED",actor,clean(input.note,"Resolution note",500,5),new Date().toISOString(),id]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("NOT_FOUND", "Open report not found.", 404);
  return { id, status: action === "RESOLVE" ? "RESOLVED" : "DISMISSED" };
}
