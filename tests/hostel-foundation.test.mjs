import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Phase 1's foundation: the landlord role, the two records registration writes,
 * and the ownership rule that keeps one landlord's property out of another's
 * workspace. The routes run against a fake Turso that records every statement,
 * so the tests assert on the arguments a query was actually given.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";

const landlords = [];
const accounts = [];
const properties = [];
const statements = [];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}

function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}

const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const inserted = (sql) => /^INSERT INTO (hostel_landlords|console_accounts|hostel_properties|admin_audit_logs)/.test(sql);

function handle(sql, args) {
  if (/^SELECT id FROM hostel_landlords WHERE email = \? OR phone = \? LIMIT 1/.test(sql)) {
    const row = landlords.find((item) => item.email === args[0] || item.phone === args[1]);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/^SELECT id FROM console_accounts WHERE email = \? LIMIT 1/.test(sql)) {
    const row = accounts.find((item) => item.email === args[0]);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/INSERT INTO hostel_landlords/.test(sql)) {
    const [id, name, phone, email, organization, , , createdAt, updatedAt] = args;
    landlords.push({ id, name, phone, email, organization, status: "ACTIVE", kyc_status: "PENDING", review_reason: "", commission_bps: 500, created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/INSERT INTO console_accounts/.test(sql)) {
    const [id, email, name, phone, , , , role, status, profile_id] = args;
    accounts.push({ id, email, name, phone, role, status, profile_id });
    return ok();
  }
  if (/FROM hostel_landlords WHERE id = \? LIMIT 1/.test(sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row
      ? table(["id", "name", "phone", "email", "organization", "status", "kyc_status", "review_reason", "commission_bps", "created_at", "updated_at"], [row])
      : empty);
  }
  if (/FROM hostel_properties WHERE landlord_id = \? ORDER BY created_at DESC/.test(sql)) {
    const rows = properties.filter((item) => item.landlord_id === args[0]);
    return ok(table(["id", "name", "address", "latitude", "longitude", "campus_distance_m", "utilities_enabled", "status", "created_at", "updated_at"], rows));
  }
  // The ownership check: a property only answers when the landlord id matches
  // the one the caller passed, which is what makes another landlord's row 404.
  if (/FROM hostel_properties WHERE id = \? AND landlord_id = \? LIMIT 1/.test(sql)) {
    const row = properties.find((item) => item.id === args[0] && item.landlord_id === args[1]);
    return ok(row
      ? table(["id", "name", "address", "latitude", "longitude", "campus_distance_m", "utilities_enabled", "status", "created_at", "updated_at"], [row])
      : empty);
  }
  if (/INSERT INTO hostel_properties/.test(sql)) {
    const [id, landlordId, name, address, latitude, longitude, utilitiesEnabled, createdAt, updatedAt] = args;
    properties.push({ id, landlord_id: landlordId, name, address, latitude: latitude === null ? null : Number(latitude), longitude: longitude === null ? null : Number(longitude), campus_distance_m: null, utilities_enabled: utilitiesEnabled, status: "DRAFT", created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/INSERT INTO rate_limit_windows/.test(sql) && /RETURNING count/.test(sql)) return ok(table(["count"], [{ count: 1 }]));
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      statements.push({ sql: stmt.sql, args });
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { consoleApplicationById, implementedConsoleApplicationIds } = await vite.ssrLoadModule("/lib/console-applications.ts");
const { CONSOLE_ROLES } = await vite.ssrLoadModule("/lib/console-auth.ts");
const { createHostelProperty, getHostelProperty, listHostelProperties, registerLandlord } = await vite.ssrLoadModule("/lib/hostel-engine/landlord.ts");
const applicationRoute = await vite.ssrLoadModule("/app/api/console/applications/[programme]/route.ts");

const landlordInput = {
  name: "Mr. Owusu",
  phone: "0551234567",
  email: "owusu@example.com",
  organization: "Owusu Hostels",
  password: "Landlord@123",
};

test("the landlord application opens the role the server can create", () => {
  const application = consoleApplicationById("landlord");
  assert.ok(application, "the landlord application must exist");
  assert.equal(application.status, "OPEN");
  assert.equal(application.role, "LANDLORD");
  assert.equal(application.activation, "DIRECT", "a landlord builds straight away; review gates the listing");
  assert.ok(CONSOLE_ROLES.includes("LANDLORD"), "the console must know the role");
  assert.ok(implementedConsoleApplicationIds.includes("landlord"), "the server must implement the programme");
});

test("registering a landlord writes both records and signs the account in immediately", async () => {
  statements.length = 0;
  const response = await applicationRoute.POST(
    new Request("https://console.example/api/console/applications/landlord", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0.1" },
      body: JSON.stringify(landlordInput),
    }),
    { params: Promise.resolve({ programme: "landlord" }) },
  );
  const payload = await response.json();
  assert.equal(response.status, 202, JSON.stringify(payload));
  assert.equal(payload.status, "ACTIVE");

  const landlordInsert = statements.find((entry) => /INSERT INTO hostel_landlords/.test(entry.sql));
  assert.ok(landlordInsert, "the landlord profile must be written");
  assert.equal(landlordInsert.args[4], "Owusu Hostels");
  const accountInsert = statements.find((entry) => /INSERT INTO console_accounts/.test(entry.sql));
  assert.ok(accountInsert, "the console account must be written");
  assert.equal(accountInsert.args[7], "LANDLORD", "the account carries the new role");
  assert.equal(accountInsert.args[8], "ACTIVE", "DIRECT activation signs in at once");
  assert.equal(accountInsert.args[9], landlordInsert.args[0], "the account points at the landlord profile");
  const audit = statements.find((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql));
  assert.ok(audit, "registration must be audited");
  assert.equal(audit.args[2], "LANDLORD_REGISTERED", "the audit row names the action");
  assert.equal(audit.args[3], "hostel_landlord", "the audit row names what was created");
});

test("a duplicate landlord is refused before a second account is written", async () => {
  const before = statements.length;
  await assert.rejects(
    () => registerLandlord({ ...landlordInput, phone: "0559999999", email: "owusu@example.com" }),
    (error) => error?.code === "CONFLICT",
  );
  const written = statements.slice(before).filter((entry) => inserted(entry.sql));
  assert.deepEqual(written, [], "a refused application must not write anything");
});

test("a property belongs to the landlord who created it", async () => {
  const created = await createHostelProperty("landlord-a", {
    name: "Green View Hostel",
    address: "Near UMaT main gate",
    latitude: 5.3009,
    longitude: -1.9897,
    utilitiesEnabled: true,
  });
  assert.equal(created.name, "Green View Hostel");
  assert.equal(created.status, "DRAFT");
  assert.equal(created.utilitiesEnabled, true);
  assert.equal(created.latitude, 5.3009);

  const list = await listHostelProperties("landlord-a");
  assert.equal(list.length, 1);
  assert.deepEqual(await listHostelProperties("landlord-b"), [], "another landlord's list never shows the property");

  await assert.rejects(
    () => getHostelProperty("landlord-b", created.id),
    (error) => error?.code === "NOT_FOUND",
    "a valid id is not a permission",
  );
  const crossRead = statements.filter((entry) => /WHERE id = \? AND landlord_id = \?/.test(entry.sql)).at(-1);
  assert.deepEqual(crossRead.args, [created.id, "landlord-b"], "the owner id is bound into the query, not filtered after");
});

test("validation happens before the database is touched", async () => {
  const before = statements.length;
  await assert.rejects(() => registerLandlord({ ...landlordInput, email: "new@example.com", password: "weak" }));
  await assert.rejects(() => createHostelProperty("landlord-a", { name: "G", address: "Somewhere" }));
  await assert.rejects(() => createHostelProperty("landlord-a", { name: "Green View Annexe", address: "Somewhere", latitude: 999, longitude: 1 }));
  assert.equal(statements.length, before, "no statement should leave the worker for invalid input");
});

test("the hostel schema ships in both migration files", async () => {
  const foundation = await readFile(new URL("../sql/014_hostel_foundation.sql", import.meta.url), "utf8");
  const consolidated = await readFile(new URL("../sql/000_umatexpress_full_migration.sql", import.meta.url), "utf8");
  const tables = [...foundation.matchAll(/CREATE TABLE IF NOT EXISTS (hostel_\w+)/g)].map((match) => match[1]);
  assert.equal(tables.length, 7, "phase 1 ships seven hostel tables");
  for (const table of tables) assert.ok(consolidated.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `000 is missing ${table}`);
  assert.match(foundation, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_listings_space_period ON hostel_listings\(space_id, period_id\)/);
  assert.match(foundation, /CHECK \(capacity BETWEEN 1 AND 6\)/);
  assert.ok(!/password_hash/.test(foundation), "credentials live in console_accounts, not the landlord row");
});
