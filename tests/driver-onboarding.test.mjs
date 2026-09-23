import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Drivers apply for the job.
 *
 * Driving was the last role only operations could create, so a candidate had to
 * reach a person before they could exist as an applicant. These tests hold the
 * shape of the self-service version: one form writes a parked account and an
 * inactive driver, a reviewer decides, and approval opens the console without
 * putting anyone on the road — the vehicle and zone still come from operations.
 * The routes run against a fake Turso that records every statement.
 */

process.env.TURSO_DATABASE_URL = "https://driver-onboarding-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";

const SCHEMA_VERSION = "2026-09-23.2";
const ACCOUNT_COLUMNS = ["id", "email", "name", "phone", "role", "status", "profile_id"];
const DRIVER_COLUMNS = [
  "id", "name", "phone", "email", "application_status", "review_reason", "active",
  "vehicle_id", "current_zone_id", "created_at", "updated_at", "account_id", "account_status",
];

const accounts = [];
const drivers = [];
const rides = [];
const audit = [];
const notices = [];
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

function accountFor(driverId) {
  return accounts.find((account) => account.profile_id === driverId && account.role === "DRIVER");
}

function handle(sql, args) {
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) return ok(table(["version"], [{ version: SCHEMA_VERSION }]));

  if (/SELECT COALESCE\(token_version,0\) AS token_version FROM console_accounts/.test(sql)) {
    const row = accounts.find((item) => item.id === args[0]);
    return ok(row ? table(["token_version"], [{ token_version: row.token_version }]) : empty);
  }
  if (/FROM console_accounts WHERE lower\(email\) = \? LIMIT 1/.test(sql)) {
    const row = accounts.find((item) => item.email === args[0]);
    return ok(row ? table([...ACCOUNT_COLUMNS, "password_hash", "password_salt", "password_iterations"], [row]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const row = accounts.find((item) => item.id === args[0]);
    return ok(row ? table(ACCOUNT_COLUMNS, [row]) : empty);
  }
  if (/^SELECT id FROM console_accounts WHERE email = \? LIMIT 1/.test(sql)) {
    const row = accounts.find((item) => item.email === args[0]);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/^INSERT INTO console_accounts/.test(sql)) {
    const [id, email, name, phone, hash, salt, iterations, role, status, profileId, createdAt, updatedAt] = args;
    accounts.push({ id, email, name, phone, password_hash: hash, password_salt: salt, password_iterations: iterations, role, status, profile_id: profileId, token_version: 0, created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE console_accounts SET status='ACTIVE'/.test(sql)) {
    const row = accounts.find((item) => item.id === args[1]);
    if (row) row.status = "ACTIVE";
    return ok();
  }
  if (/^UPDATE console_accounts SET status='SUSPENDED'/.test(sql)) {
    const row = accounts.find((item) => item.id === args[1]);
    if (row) row.status = "SUSPENDED";
    return ok();
  }
  if (/^UPDATE console_accounts SET token_version = COALESCE\(token_version,0\) \+ 1/.test(sql)) {
    const row = accounts.find((item) => item.id === args[1]);
    if (row) row.token_version += 1;
    return ok();
  }
  if (/^UPDATE console_accounts SET last_login_at/.test(sql)) return ok();

  if (/^SELECT id FROM campus_drivers WHERE lower\(email\) = \? OR phone = \? LIMIT 1/.test(sql)) {
    const row = drivers.find((item) => item.email === args[0] || item.phone === args[1]);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/^INSERT INTO campus_drivers/.test(sql)) {
    const [id, name, phone, email, hash, salt, iterations, changedAt, createdAt, updatedAt] = args;
    drivers.push({
      id, name, phone, email, password_hash: hash, password_salt: salt, password_iterations: iterations,
      application_status: "PENDING", review_reason: "", active: 0, vehicle_id: "", current_zone_id: "",
      created_at: createdAt, updated_at: updatedAt, password_changed_at: changedAt,
    });
    return ok();
  }
  if (/FROM campus_drivers d LEFT JOIN console_accounts a/.test(sql)) {
    const rows = drivers
      .filter((driver) => !/WHERE d\.id = \?/.test(sql) || driver.id === args[0])
      .map((driver) => ({ ...driver, account_id: accountFor(driver.id)?.id || "", account_status: accountFor(driver.id)?.status || "" }));
    return ok(table(DRIVER_COLUMNS, rows));
  }
  if (/^UPDATE campus_drivers SET application_status='APPROVED'/.test(sql)) {
    const row = drivers.find((item) => item.id === args[1]);
    if (row) Object.assign(row, { application_status: "APPROVED", review_reason: "", active: 1, updated_at: args[0] });
    return ok();
  }
  if (/^UPDATE campus_drivers SET application_status='REJECTED'/.test(sql)) {
    const row = drivers.find((item) => item.id === args[2]);
    if (row) Object.assign(row, { application_status: "REJECTED", review_reason: String(args[0]), active: 0, updated_at: args[1] });
    return ok();
  }
  if (/^UPDATE campus_drivers SET application_status='SUSPENDED'/.test(sql)) {
    const row = drivers.find((item) => item.id === args[2]);
    if (row) Object.assign(row, { application_status: "SUSPENDED", review_reason: String(args[0]), active: 0, current_zone_id: "", updated_at: args[1] });
    return ok();
  }
  if (/^UPDATE campus_rides SET status='COMPLETED',accepting_queue=0,ended_at=\?/.test(sql)) {
    for (const ride of rides.filter((item) => item.driver_id === args[2] && ["OPEN", "PAUSED", "FULL"].includes(item.status))) {
      ride.status = "COMPLETED";
    }
    return ok();
  }
  if (/^UPDATE campus_drivers SET current_zone_id = \?/.test(sql)) return ok();

  if (/INSERT INTO admin_audit_logs/.test(sql)) {
    audit.push({ actor: args[1], action: args[2], targetType: args[3], targetReference: args[4], details: args[5] });
    return ok();
  }
  if (/INSERT INTO notification_outbox/.test(sql)) {
    notices.push({ recipient: args[2], template: args[3], subject: args[4], message: args[5], reference: args[6] });
    return ok({ affected_row_count: 1 });
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

const { CONSOLE_SESSION_COOKIE, createConsoleSession } = await vite.ssrLoadModule("/lib/console-auth.ts");
const { resolveConsoleSignIn } = await vite.ssrLoadModule("/lib/console-signin.ts");
const { verifyPassword } = await vite.ssrLoadModule("/lib/campus-engine/crypto.ts");
const { consoleApplicationById, implementedConsoleApplicationIds, consoleInvitedAccess } = await vite.ssrLoadModule("/lib/console-applications.ts");
const {
  listDriverApplications, registerDriverApplication, reviewDriverApplication,
} = await vite.ssrLoadModule("/lib/campus-engine/driver-onboarding.ts");
const driversRoute = await vite.ssrLoadModule("/app/api/console/campus/drivers/route.ts");

accounts.push(
  { id: "acc-admin", email: "admin@umat.edu.gh", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-mod", email: "mod@umat.edu.gh", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-org", email: "org@example.com", name: "Organizer", phone: "", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-a", token_version: 0 },
);

const URL_BASE = "https://console.example.test";
const request = (path, init = {}) => new Request(`${URL_BASE}${path}`, init);
async function cookieFor(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id: account.id, role: account.role }))}`;
}

const application = (overrides = {}) => ({
  name: "Kofi Mensah",
  phone: "0244000111",
  email: "kofi.mensah@example.com",
  password: "Driver#2026Pass",
  ...overrides,
});

test("driving is a programme the server can process, not an invitation", () => {
  const driver = consoleApplicationById("driver");
  assert.ok(driver, "driving is declared like every other provider");
  assert.equal(driver.status, "OPEN");
  assert.equal(driver.role, "DRIVER");
  assert.equal(driver.activation, "REVIEW", "a stranger cannot sign in with a driver's powers before a decision");
  assert.equal(driver.reviewService, "campus", "the campus console owns the decision");
  assert.ok(implementedConsoleApplicationIds.includes("driver"), "the API can process what the form posts");
  assert.ok(!consoleInvitedAccess.some((entry) => entry.roles.includes("DRIVER")), "driving is no longer set up only by the team");
});

test("an application writes a parked account and a driver who is not on the road", async () => {
  statements.length = 0;
  audit.length = 0;
  const result = await registerDriverApplication(application());

  assert.equal(result.status, "PENDING");
  const driver = drivers.find((item) => item.id === result.driverId);
  assert.equal(driver.application_status, "PENDING");
  assert.equal(driver.active, 0, "an applicant is not an operating driver");
  assert.equal(driver.vehicle_id, "", "operations assigns the vehicle, not the form");
  assert.ok(driver.password_hash, "the chosen password is stored for the console door");

  const account = accounts.find((item) => item.id === result.accountId);
  assert.equal(account.role, "DRIVER");
  assert.equal(account.status, "PENDING", "the account cannot sign in until a reviewer decides");
  assert.equal(account.profile_id, result.driverId, "the account is bound to one driver record");
  assert.ok(await verifyPassword(application().password, driver.password_hash, driver.password_salt, Number(driver.password_iterations)),
    "the driver can open the legacy driver endpoint");
  assert.ok(await verifyPassword(application().password, account.password_hash, account.password_salt, Number(account.password_iterations)),
    "and the console account they applied from");

  assert.deepEqual(audit.map((row) => row.action), ["DRIVER_APPLIED"]);
  assert.deepEqual(notices, [], "registering is not a decision to announce");

  assert.equal(await resolveConsoleSignIn(application().email, application().password), null, "a pending applicant cannot sign in");
});

test("an application the server cannot create is refused before it is half-written", async () => {
  await assert.rejects(() => registerDriverApplication(application({ name: "" })), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => registerDriverApplication(application({ email: "not-an-email" })), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => registerDriverApplication(application({ password: "weak" })), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => registerDriverApplication(application()), (error) => error?.code === "CONFLICT", "the same person is not two applications");
  await assert.rejects(
    () => registerDriverApplication(application({ email: "someone.else@example.com" })),
    (error) => error?.code === "CONFLICT",
    "a phone number identifies one driver",
  );
  await assert.rejects(
    () => registerDriverApplication(application({ phone: "0200000000", email: "admin@umat.edu.gh" })),
    (error) => error?.code === "CONFLICT",
    "an email that already has a console account is refused",
  );
});

test("the queue puts the people waiting first", async () => {
  drivers.push({
    id: "driver-ops", name: "Existing Driver", phone: "0559999999", email: "existing@example.com",
    application_status: "APPROVED", review_reason: "", active: 1, vehicle_id: "vehicle-a", current_zone_id: "zone-a",
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
  });
  accounts.push({ id: "acc-existing", email: "existing@example.com", name: "Existing Driver", phone: "0559999999", role: "DRIVER", status: "ACTIVE", profile_id: "driver-ops", token_version: 0 });

  const queue = await listDriverApplications();
  assert.equal(queue[queue.length - 1].id, "driver-ops", "drivers already working come after the applicants");
  assert.ok(queue.some((driver) => driver.applicationStatus === "PENDING" && driver.accountStatus === "PENDING"));
});

test("approving a driver opens the console and tells them, but not the road", async () => {
  notices.length = 0;
  audit.length = 0;
  const applicant = drivers.find((driver) => driver.application_status === "PENDING");
  const approved = await reviewDriverApplication({ driverId: applicant.id, action: "APPROVE", actor: "admin@umat.edu.gh" });

  assert.equal(approved.applicationStatus, "APPROVED");
  assert.equal(approved.active, true);
  assert.equal(approved.accountStatus, "ACTIVE");
  assert.equal(approved.vehicleId, "", "approval is about the person; operations still assigns the vehicle");
  assert.deepEqual(audit.map((row) => row.action), ["DRIVER_APPLICATION_APPROVE"]);
  assert.deepEqual(notices.map((row) => row.template), ["driver_application_approved"]);
  assert.equal(notices[0].recipient, "kofi.mensah@example.com", "the driver is told, not the administrator");
  assert.equal(notices[0].reference, applicant.id);
  assert.match(notices[0].message, /campusRide driver/, "the notice speaks for campusRide");

  const signIn = await resolveConsoleSignIn("kofi.mensah@example.com", application().password);
  assert.equal(signIn?.account.role, "DRIVER", "the driver can now sign in at the console they applied from");
  assert.equal(signIn?.account.profileId, applicant.id);

  await assert.rejects(
    () => reviewDriverApplication({ driverId: applicant.id, action: "APPROVE", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE",
    "an approved driver is not approved twice",
  );
});

test("a rejection keeps the account parked and says what to fix", async () => {
  notices.length = 0;
  drivers.push({
    id: "driver-reject", name: "Ama Boateng", phone: "0244000222", email: "ama@example.com",
    application_status: "PENDING", review_reason: "", active: 0, vehicle_id: "", current_zone_id: "",
    created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z",
  });
  accounts.push({ id: "acc-ama", email: "ama@example.com", name: "Ama Boateng", phone: "0244000222", role: "DRIVER", status: "PENDING", profile_id: "driver-reject", token_version: 0 });

  await assert.rejects(
    () => reviewDriverApplication({ driverId: "driver-reject", action: "REJECT", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
    "a rejection without a reason leaves the applicant with nothing to do",
  );

  const rejected = await reviewDriverApplication({ driverId: "driver-reject", action: "REJECT", reason: "The licence photo is unreadable.", actor: "admin@umat.edu.gh" });
  assert.equal(rejected.applicationStatus, "REJECTED");
  assert.equal(rejected.active, false);
  assert.equal(rejected.accountStatus, "PENDING", "a rejected applicant still cannot sign in");
  assert.deepEqual(notices.map((row) => row.template), ["driver_application_rejected"]);
  assert.match(notices[0].message, /The licence photo is unreadable/);
});

test("suspending stops the account, ends their ride and takes them off the map", async () => {
  notices.length = 0;
  audit.length = 0;
  rides.push({ id: "ride-live", driver_id: "driver-ops", status: "OPEN" });

  await assert.rejects(
    () => reviewDriverApplication({ driverId: "driver-reject", action: "SUSPEND", reason: "Any reason", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE",
    "someone who was never approved is rejected, not suspended",
  );
  await assert.rejects(
    () => reviewDriverApplication({ driverId: "driver-ops", action: "SUSPEND", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
  );

  const suspended = await reviewDriverApplication({ driverId: "driver-ops", action: "SUSPEND", reason: "Repeated no-shows.", actor: "admin@umat.edu.gh" });
  assert.equal(suspended.applicationStatus, "SUSPENDED");
  assert.equal(suspended.active, false);
  assert.equal(suspended.currentZoneId, "", "a suspended driver is not on the map");
  assert.equal(suspended.accountStatus, "SUSPENDED");
  assert.equal(rides.find((ride) => ride.id === "ride-live").status, "COMPLETED", "a stopped driver does not keep collecting passengers");
  assert.equal(accounts.find((item) => item.id === "acc-existing").token_version, 1, "their live sessions are retired");
  assert.deepEqual(audit.map((row) => row.action), ["DRIVER_APPLICATION_SUSPEND"]);
  assert.deepEqual(notices.map((row) => row.template), ["driver_application_suspended"]);
  assert.match(notices[0].message, /Repeated no-shows/);
});

test("the driver queue is an administrator's, and validates what it is sent", async () => {
  const signedOut = await driversRoute.GET(request("/api/console/campus/drivers"));
  assert.equal(signedOut.status, 401);
  accounts.push({ id: "acc-driver-guard", email: "guard@example.com", name: "Guard Driver", phone: "0550000001", role: "DRIVER", status: "ACTIVE", profile_id: "driver-guard", token_version: 0 });
  const asDriver = await driversRoute.GET(request("/api/console/campus/drivers", { headers: { cookie: await cookieFor("acc-driver-guard") } }));
  assert.equal(asDriver.status, 403);
  const asModerator = await driversRoute.GET(request("/api/console/campus/drivers", { headers: { cookie: await cookieFor("acc-mod") } }));
  assert.equal(asModerator.status, 403, "drivers, vehicles and zones belong to one role");

  const cookie = await cookieFor("acc-admin");
  const response = await driversRoute.GET(request("/api/console/campus/drivers", { headers: { cookie } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.drivers.length >= 3, "the queue lists every driver with their application state");

  const badAction = await driversRoute.PATCH(request("/api/console/campus/drivers", {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ driverId: "driver-ops", action: "PROMOTE" }),
  }));
  assert.equal(badAction.status, 400);
  const missing = await driversRoute.PATCH(request("/api/console/campus/drivers", {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "APPROVE" }),
  }));
  assert.equal(missing.status, 400);
  const unknown = await driversRoute.PATCH(request("/api/console/campus/drivers", {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ driverId: "driver-nope", action: "APPROVE" }),
  }));
  assert.equal(unknown.status, 404);
});
