import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The console switchboard. A deployment's payout automation is a policy, so it
 * lives in `platform_settings` where an administrator can flip it, with the
 * environment variable as the fallback. These tests run the engine and the
 * admin route against a fake Turso.
 */

process.env.TURSO_DATABASE_URL = "https://platform-settings-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
delete process.env.PAYOUT_AUTO_ENABLED;
delete process.env.HOSTEL_PAYOUT_AUTO_ENABLED;

const settings = new Map();
const audits = [];
const accounts = new Map([
  ["console-admin", { id: "console-admin", email: "admin@umat.edu.gh", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "" }],
  ["console-organizer", { id: "console-organizer", email: "organizer@example.com", name: "Organizer", phone: "", role: "ORGANIZER", status: "ACTIVE", profile_id: "" }],
]);

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
const affected = (count) => ok({ affected_row_count: count });

function handle(sql, args) {
  if (/^SELECT version FROM campus_schema_meta|^SELECT version FROM schema_passes/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO campus_schema_meta|^INSERT OR REPLACE INTO schema_passes/.test(sql)) return affected(1);
  if (/^CREATE |^ALTER |^DELETE FROM /.test(sql)) return ok(empty);
  if (/^UPDATE /.test(sql)) return affected(0);

  if (/^INSERT INTO platform_settings/.test(sql)) {
    const [key, value, updatedBy, updatedAt] = args;
    settings.set(key, { key, value, updated_by: updatedBy, updated_at: updatedAt });
    return affected(1);
  }
  if (/^SELECT key, value, COALESCE\(updated_by,''\) AS updated_by/.test(sql)) {
    const rows = [...settings.values()];
    return ok(rows.length ? table(["key", "value", "updated_by", "updated_at"], rows) : empty);
  }

  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    const [id, admin_email, action, target_type, target_reference, details, created_at] = args;
    audits.push({ id, admin_email, action, target_type, target_reference, details, created_at });
    return affected(1);
  }

  if (/^SELECT id,email,name,COALESCE\(phone,''\) AS phone,role,status/.test(sql)) {
    const row = accounts.get(args[0]);
    return ok(row ? table(["id", "email", "name", "phone", "role", "status", "profile_id"], [row]) : empty);
  }
  if (/^SELECT COALESCE\(token_version,0\) AS token_version/.test(sql)) {
    return ok(table(["token_version"], [{ token_version: 0 }]));
  }

  if (/^INSERT INTO rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://platform-settings-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests
      .filter((request) => request.type === "execute")
      .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  PLATFORM_SETTING_DEFINITIONS, listPlatformSettings, platformSettingState, resetPlatformSettingsCache, setPlatformSetting,
} = await vite.ssrLoadModule("/lib/platform-settings.ts");
const { hostelPayoutAutoEnabled, runHostelPayoutReleaseJob } = await vite.ssrLoadModule("/lib/hostel-engine/payouts.ts");
const { payoutAutoEnabled } = await vite.ssrLoadModule("/lib/organizer-payouts.ts");
const settingsRoute = await vite.ssrLoadModule("/app/api/console/settings/route.ts");
const { CONSOLE_SESSION_COOKIE, createConsoleSession } = await vite.ssrLoadModule("/lib/console-auth.ts");

beforeEach(() => {
  settings.clear();
  audits.length = 0;
  delete process.env.PAYOUT_AUTO_ENABLED;
  delete process.env.HOSTEL_PAYOUT_AUTO_ENABLED;
  resetPlatformSettingsCache();
});

async function cookieFor(id) {
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id, role: accounts.get(id).role }))}`;
}

function apiRequest(method, cookie, body) {
  return new Request("https://console.example.test/api/console/settings", {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("a switch is off until someone sets it", async () => {
  const state = await platformSettingState("hostel_payout_auto");
  assert.equal(state.enabled, false);
  assert.equal(state.source, "DEFAULT");
  assert.equal(await hostelPayoutAutoEnabled(), false);
  assert.equal(await payoutAutoEnabled(), false);
});

test("the environment variable decides while no override is stored", async () => {
  process.env.HOSTEL_PAYOUT_AUTO_ENABLED = "true";
  process.env.PAYOUT_AUTO_ENABLED = "true";
  const state = await platformSettingState("hostel_payout_auto");
  assert.equal(state.enabled, true, "a deployment that only sets the variable keeps working");
  assert.equal(state.source, "ENV");
  assert.equal(await payoutAutoEnabled(), true);
});

test("an override in the console wins over the environment", async () => {
  process.env.HOSTEL_PAYOUT_AUTO_ENABLED = "true";
  await setPlatformSetting({ key: "hostel_payout_auto", enabled: false, actor: "admin@umat.edu.gh" });
  const state = await platformSettingState("hostel_payout_auto");
  assert.equal(state.enabled, false, "the console holds the answer once it is set");
  assert.equal(state.source, "SETTING");
  assert.equal(state.updatedBy, "admin@umat.edu.gh");
  assert.equal(await hostelPayoutAutoEnabled(), false);

  await setPlatformSetting({ key: "hostel_payout_auto", enabled: true, actor: "admin@umat.edu.gh" });
  assert.equal(await hostelPayoutAutoEnabled(), true, "turning it back on is the same write");
  assert.equal(settings.get("hostel_payout_auto").value, "1");
});

test("the two products keep separate switches", async () => {
  await setPlatformSetting({ key: "hostel_payout_auto", enabled: true, actor: "admin@umat.edu.gh" });
  assert.equal(await hostelPayoutAutoEnabled(), true);
  assert.equal(await payoutAutoEnabled(), false, "hostel automation must not turn on the trip side");
  const listed = await listPlatformSettings();
  assert.deepEqual(listed.map((entry) => entry.key), PLATFORM_SETTING_DEFINITIONS.map((entry) => entry.key));
});

test("every write is audited against the administrator", async () => {
  await setPlatformSetting({ key: "organizer_payout_auto", enabled: true, actor: "admin@umat.edu.gh" });
  const entry = audits.find((item) => item.action === "platform_setting_updated");
  assert.ok(entry, "the switch change must land in the audit log");
  assert.equal(entry.admin_email, "admin@umat.edu.gh");
  assert.equal(entry.target_type, "platform_setting");
  assert.equal(entry.target_reference, "organizer_payout_auto");
  assert.match(String(entry.details), /"enabled":true/);
});

test("an unknown key or a non-boolean value is refused", async () => {
  await assert.rejects(
    () => setPlatformSetting({ key: "delete_the_database", enabled: true, actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR" && error.status === 400,
  );
  await assert.rejects(
    () => setPlatformSetting({ key: "hostel_payout_auto", enabled: "maybe", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  assert.equal(settings.size, 0, "a refused write must not be stored");
});

test("the hostel release job follows the console switch", async () => {
  const skipped = await runHostelPayoutReleaseJob({ limit: 2 });
  assert.equal(skipped.status, "SKIPPED");
  assert.equal(skipped.reason, "AUTO_DISABLED");

  await setPlatformSetting({ key: "hostel_payout_auto", enabled: true, actor: "admin@umat.edu.gh" });
  const ran = await runHostelPayoutReleaseJob({ limit: 2 });
  assert.equal(ran.status, "RAN", "with the switch on, the job is allowed past its gate");
});

test("the settings API is admin-only", async () => {
  const anonymous = await settingsRoute.GET(apiRequest("GET"));
  assert.equal(anonymous.status, 401);

  const organizer = await settingsRoute.GET(apiRequest("GET", await cookieFor("console-organizer")));
  assert.equal(organizer.status, 403, "only an administrator reads the switchboard");

  const blocked = await settingsRoute.PATCH(apiRequest("PATCH", await cookieFor("console-organizer"), { key: "hostel_payout_auto", enabled: true }));
  assert.equal(blocked.status, 403);
  assert.equal(settings.size, 0);
});

test("an administrator reads and flips a switch through the API", async () => {
  const admin = await cookieFor("console-admin");
  const before = await settingsRoute.GET(apiRequest("GET", admin));
  assert.equal(before.status, 200);
  const listed = await before.json();
  assert.equal(listed.settings.find((entry) => entry.key === "hostel_payout_auto").enabled, false);
  assert.match(before.headers.get("cache-control") || "", /no-store/);

  const flipped = await settingsRoute.PATCH(apiRequest("PATCH", admin, { key: "hostel_payout_auto", enabled: true }));
  assert.equal(flipped.status, 200);
  const payload = await flipped.json();
  assert.equal(payload.setting.enabled, true);
  assert.equal(payload.setting.source, "SETTING");

  const after = await (await settingsRoute.GET(apiRequest("GET", admin))).json();
  assert.equal(after.settings.find((entry) => entry.key === "hostel_payout_auto").enabled, true);
  assert.equal(await hostelPayoutAutoEnabled(), true, "the API write is visible to the job that asks");

  const unknown = await settingsRoute.PATCH(apiRequest("PATCH", admin, { key: "nope", enabled: true }));
  assert.equal(unknown.status, 400);
});

test("a numeric limit is written, read back and clamped through the API", async () => {
  const admin = await cookieFor("console-admin");
  const saved = await settingsRoute.PATCH(apiRequest("PATCH", admin, { key: "cinema_room_idle_minutes", value: 45 }));
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  assert.equal(payload.setting.value, 45);
  assert.equal(payload.setting.kind, "number");
  assert.equal(settings.get("cinema_room_idle_minutes").value, "45");

  const listed = await (await settingsRoute.GET(apiRequest("GET", admin))).json();
  assert.equal(listed.settings.find((entry) => entry.key === "cinema_room_idle_minutes").value, 45);

  const clamped = await settingsRoute.PATCH(apiRequest("PATCH", admin, { key: "cinema_retention_hours", value: 999 }));
  assert.equal((await clamped.json()).setting.value, 48, "a limit cannot be set outside its documented bounds");
  const refused = await settingsRoute.PATCH(apiRequest("PATCH", admin, { key: "cinema_room_idle_minutes", value: "soon" }));
  assert.equal(refused.status, 400);
});
