import { CampusEngineError } from "@/lib/campus-engine/errors";
import { assertConsolePassword, createConsoleAccount, ensureConsoleAccountsTable, revokeConsoleSessions } from "@/lib/console-auth";
import { ensureFoodDirectoryTables } from "@/lib/food/listings";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS food_vendor_profiles (id TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE,business_name TEXT NOT NULL,provider_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'PENDING',review_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_food_vendor_provider ON food_vendor_profiles(provider_id) WHERE provider_id<>''`,
];
let ready: Promise<void> | null = null;
export function ensureFoodVendorTables() {
  ready ??= Promise.all([ensureConsoleAccountsTable(), ensureFoodDirectoryTables(), runSchemaPass({ id: "food-vendors", version: "1", statements: SCHEMA })]).then(() => undefined).catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

export type FoodVendor = { id: string; accountId: string; businessName: string; providerId: string; providerName: string; status: string; reviewNote: string; name: string; email: string; phone: string; createdAt: string };
function view(row: Record<string, unknown>): FoodVendor {
  return { id: String(row.id), accountId: String(row.account_id), businessName: String(row.business_name), providerId: String(row.provider_id || ""), providerName: String(row.provider_name || ""), status: String(row.status), reviewNote: String(row.review_note || ""), name: String(row.name), email: String(row.email), phone: String(row.phone || ""), createdAt: String(row.created_at) };
}
const SELECT = `SELECT v.*,a.name,a.email,a.phone,COALESCE(p.name,'') AS provider_name FROM food_vendor_profiles v JOIN console_accounts a ON a.id=v.account_id LEFT JOIN food_providers p ON p.id=v.provider_id`;

export async function registerFoodVendor(input: Record<string, unknown>) {
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Food vendor applications are unavailable on this deployment.", 503);
  const name = String(input.name || "").trim(); const businessName = String(input.organization || "").trim();
  const phone = String(input.phone || "").trim(); const email = String(input.email || "").trim().toLowerCase(); const password = String(input.password || "");
  if (name.length < 2 || businessName.length < 2 || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CampusEngineError("VALIDATION_ERROR", "Enter your name, food business, phone number and a valid email address.", 400);
  assertConsolePassword("VENDOR", password); await ensureFoodVendorTables();
  if (rowsToObjects(await turso("SELECT id FROM console_accounts WHERE lower(email)=? LIMIT 1", [email])).length) throw new CampusEngineError("CONFLICT", "That email already belongs to a console account.", 409);
  const id = crypto.randomUUID();
  let accountId = "";
  try {
    accountId = await createConsoleAccount({ email, password, name, phone, role: "VENDOR", profileId: id, status: "ACTIVE" });
    const now = new Date().toISOString();
    await turso("INSERT INTO food_vendor_profiles (id,account_id,business_name,provider_id,status,created_at,updated_at) VALUES (?,?,?,'','PENDING',?,?)", [id,accountId,businessName,now,now]);
    return { id, accountId, status: "PENDING" };
  } catch (error) {
    if (accountId) await turso("DELETE FROM console_accounts WHERE id=? AND role='VENDOR'", [accountId]).catch(() => undefined);
    throw error;
  }
}

export async function listFoodVendors() {
  await ensureFoodVendorTables();
  return rowsToObjects(await turso(`${SELECT} ORDER BY CASE v.status WHEN 'PENDING' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END,v.created_at DESC`)).map(view);
}

export async function foodVendorForProfile(id: string) {
  await ensureFoodVendorTables();
  const row = rowsToObjects(await turso(`${SELECT} WHERE v.id=? LIMIT 1`, [id]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "Food vendor profile not found.", 404);
  return view(row);
}

export async function assignFoodVendor(input: { vendorId: unknown; providerId: unknown; status: unknown; note: unknown }) {
  await ensureFoodVendorTables();
  const vendorId = String(input.vendorId || "").trim(); const providerId = String(input.providerId || "").trim();
  const status = String(input.status || "").toUpperCase(); const note = String(input.note || "").trim();
  if (!vendorId || !["ACTIVE","SUSPENDED"].includes(status) || note.length < 10 || note.length > 500) throw new CampusEngineError("VALIDATION_ERROR", "Choose a vendor, decision, and record a note of at least 10 characters.", 400);
  if (status === "ACTIVE") {
    if (!providerId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the verified provider this vendor manages.", 400);
    const provider = rowsToObjects(await turso("SELECT id FROM food_providers WHERE id=? AND status='PUBLISHED' LIMIT 1", [providerId]))[0];
    if (!provider) throw new CampusEngineError("INVALID_STATE", "Publish and verify the provider before assigning its vendor.", 409);
  }
  const now = new Date().toISOString();
  try { await turso("UPDATE food_vendor_profiles SET provider_id=?,status=?,review_note=?,updated_at=? WHERE id=?", [status === "ACTIVE" ? providerId : "",status,note,now,vendorId]); }
  catch (error) { if (error instanceof Error && /unique/i.test(error.message)) throw new CampusEngineError("CONFLICT", "That provider already has a vendor account.", 409); throw error; }
  const vendor = await foodVendorForProfile(vendorId);
  await turso("UPDATE console_accounts SET status=?,token_version=COALESCE(token_version,0)+1,updated_at=? WHERE id=?", [status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",now,vendor.accountId]);
  await revokeConsoleSessions(vendor.accountId);
  return foodVendorForProfile(vendorId);
}
