import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * KYC is the money gate: a payout is refused until the person behind an
 * organizer or a landlord account has been verified. These tests hold the
 * decision itself — who may make it, what it needs, and the fact that it never
 * touches what the account may publish.
 */

process.env.TURSO_DATABASE_URL = "https://console-kyc-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";

const accounts = [];
const organizers = [];
const landlords = [];
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

const ORGANIZER_COLUMNS = ["id", "name", "phone", "email", "organization", "status", "kyc_status", "commission_bps", "created_at", "updated_at", "account_id", "account_status"];
const LANDLORD_COLUMNS = ["id", "name", "phone", "email", "organization", "status", "kyc_status", "review_reason", "commission_bps", "created_at", "updated_at"];

function handle(sql, args) {
  if (/SELECT COALESCE\(token_version,0\) AS token_version FROM console_accounts/.test(sql)) {
    const row = accounts.find((item) => item.id === args[0]);
    return ok(row ? table(["token_version"], [{ token_version: 0 }]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const row = accounts.find((item) => item.id === args[0]);
    return ok(row ? table(["id", "email", "name", "phone", "role", "status", "profile_id"], [row]) : empty);
  }
  if (/FROM trip_organizers o LEFT JOIN console_accounts a/.test(sql)) {
    const row = organizers.find((item) => item.id === args[0]);
    return ok(row ? table(ORGANIZER_COLUMNS, [{ ...row, account_id: "", account_status: "" }]) : empty);
  }
  if (/^UPDATE trip_organizers SET kyc_status=\?,kyc_reason=\?,kyc_reviewed_at=\?,updated_at=\? WHERE id=\?/.test(sql)) {
    const [status, reason, reviewedAt, updatedAt, id] = args;
    const row = organizers.find((item) => item.id === id);
    if (row) Object.assign(row, { kyc_status: status, kyc_reason: reason, kyc_reviewed_at: reviewedAt, updated_at: updatedAt });
    return ok();
  }
  if (/FROM hostel_landlords WHERE id = \? LIMIT 1/.test(sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row ? table(LANDLORD_COLUMNS, [row]) : empty);
  }
  if (/FROM hostel_landlords\s+ORDER BY CASE/.test(sql)) {
    const rows = [...landlords].sort((left, right) => {
      const rank = (row) => (row.kyc_status === "PENDING" ? 0 : row.kyc_status === "REJECTED" ? 1 : 2);
      return rank(left) - rank(right) || String(right.created_at).localeCompare(String(left.created_at));
    });
    return ok(table(LANDLORD_COLUMNS, rows));
  }
  if (/^UPDATE hostel_landlords SET kyc_status=\?,review_reason=\?,updated_at=\? WHERE id=\?/.test(sql)) {
    const [status, reason, updatedAt, id] = args;
    const row = landlords.find((item) => item.id === id);
    if (row) Object.assign(row, { kyc_status: status, review_reason: reason, updated_at: updatedAt });
    return ok();
  }
  if (/INSERT INTO admin_audit_logs/.test(sql)) {
    audit.push({ actor: args[1], action: args[2], targetType: args[3], targetReference: args[4], details: args[5], createdAt: args[6] });
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
const { reviewOrganizerKyc } = await vite.ssrLoadModule("/lib/organizers.ts");
const { listHostelLandlordsForStaff } = await vite.ssrLoadModule("/lib/hostel-engine/landlord.ts");
const organizersRoute = await vite.ssrLoadModule("/app/api/console/organizers/route.ts");
const landlordsRoute = await vite.ssrLoadModule("/app/api/console/hostel/landlords/route.ts");

accounts.push(
  { id: "acc-admin", email: "admin@umat.edu.gh", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "" },
  { id: "acc-mod", email: "mod@umat.edu.gh", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "" },
  { id: "acc-org", email: "org@example.com", name: "Organizer", phone: "", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-a" },
);
organizers.push({
  id: "org-a", name: "Agbo Merashack Kwesi", phone: "0550000000", email: "org@example.com", organization: "All Students transport",
  status: "APPROVED", kyc_status: "PENDING", kyc_reason: "", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
});
landlords.push(
  { id: "landlord-pending", name: "Mr. Owusu", phone: "0551234567", email: "owusu@example.com", organization: "Owusu Hostels", status: "ACTIVE", kyc_status: "PENDING", review_reason: "", commission_bps: 500, created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z" },
  { id: "landlord-verified", name: "Mr. Mensah", phone: "0559999999", email: "mensah@example.com", organization: "Mensah Lodge", status: "ACTIVE", kyc_status: "VERIFIED", review_reason: "", commission_bps: 500, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
);

async function cookieFor(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id: account.id, role: account.role }))}`;
}
const URL_BASE = "https://console.example.test";

function request(path, { method = "GET", cookie = "", body } = {}) {
  return new Request(`${URL_BASE}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("an administrator verifies an organizer's KYC from the console", async () => {
  statements.length = 0;
  audit.length = 0;
  const response = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH",
    cookie: await cookieFor("acc-admin"),
    body: { organizerId: "org-a", action: "VERIFY_KYC" },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.organizer.kycStatus, "VERIFIED");
  assert.equal(organizers[0].kyc_status, "VERIFIED");
  assert.equal(organizers[0].kyc_reason, "");
  const entry = audit.find((row) => row.action === "ORGANIZER_KYC_VERIFY");
  assert.ok(entry, "the decision must be audited");
  assert.equal(entry.actor, "admin@umat.edu.gh");
  assert.equal(entry.targetType, "trip_organizer");
  assert.match(String(entry.details), /PENDING/);
});

test("organizer KYC needs a reason to reject and a live account to verify", async () => {
  const cookie = await cookieFor("acc-admin");
  organizers[0].kyc_status = "PENDING";
  const rejected = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH", cookie, body: { organizerId: "org-a", action: "REJECT_KYC" },
  }));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "Give a reason so the organizer knows what to fix.");
  assert.equal(organizers[0].kyc_status, "PENDING", "a refused decision must not change the record");

  const withReason = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH", cookie, body: { organizerId: "org-a", action: "REJECT_KYC", reason: "ID number does not match the name." },
  }));
  assert.equal(withReason.status, 200);
  assert.equal(organizers[0].kyc_status, "REJECTED");
  assert.equal(organizers[0].kyc_reason, "ID number does not match the name.");

  organizers[0].status = "SUSPENDED";
  await assert.rejects(
    () => reviewOrganizerKyc({ organizerId: "org-a", action: "VERIFY", actor: "admin@umat.edu.gh" }),
    (error) => error.status === 409 && /Approve the organizer/.test(error.message),
  );
  organizers[0].status = "APPROVED";
});

test("only staff decide an organizer's KYC", async () => {
  const organizerCookie = await cookieFor("acc-org");
  const signedOut = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH", body: { organizerId: "org-a", action: "VERIFY_KYC" },
  }));
  assert.equal(signedOut.status, 401);
  const forbidden = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH", cookie: organizerCookie, body: { organizerId: "org-a", action: "VERIFY_KYC" },
  }));
  assert.equal(forbidden.status, 403);
});

test("a moderator can verify a landlord, and a rejection keeps its reason", async () => {
  statements.length = 0;
  audit.length = 0;
  notices.length = 0;
  const rejected = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", {
    method: "PATCH", cookie: await cookieFor("acc-mod"), body: { landlordId: "landlord-pending", action: "REJECT_KYC" },
  }));
  assert.equal(rejected.status, 400, "a rejection without a reason is refused");
  assert.equal(landlords[0].kyc_status, "PENDING");
  assert.deepEqual(notices, [], "a refused decision tells nobody anything");

  const withReason = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", {
    method: "PATCH", cookie: await cookieFor("acc-mod"), body: { landlordId: "landlord-pending", action: "REJECT_KYC", reason: "Phone number does not reach the landlord." },
  }));
  assert.equal(withReason.status, 200);
  const rejectedBody = await withReason.json();
  assert.equal(rejectedBody.landlord.kycStatus, "REJECTED");
  assert.equal(rejectedBody.landlord.reviewReason, "Phone number does not reach the landlord.");
  assert.deepEqual(notices.map((row) => row.template), ["landlord_kyc_rejected"], "the landlord is the second party to a KYC decision");
  assert.equal(notices[0].recipient, "owusu@example.com", "the landlord is told, not the moderator who decided");
  assert.equal(notices[0].reference, "landlord-pending");
  assert.match(notices[0].message, /Phone number does not reach the landlord/, "the landlord is told what to fix");

  notices.length = 0;
  const verified = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", {
    method: "PATCH", cookie: await cookieFor("acc-mod"), body: { landlordId: "landlord-pending", action: "VERIFY_KYC" },
  }));
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.landlord.kycStatus, "VERIFIED");
  assert.equal(verifiedBody.landlord.reviewReason, "", "verifying clears the old rejection reason");
  assert.deepEqual(notices.map((row) => row.template), ["landlord_kyc_verified"]);
  assert.match(notices[0].message, /payments can be sent/i, "the money gate says what a verified landlord may count on");

  const entries = audit.filter((row) => row.targetType === "hostel_landlord");
  assert.deepEqual(entries.map((row) => row.action), ["HOSTEL_LANDLORD_KYC_REJECT", "HOSTEL_LANDLORD_KYC_VERIFY"]);
  assert.equal(entries[0].actor, "mod@umat.edu.gh");
  const touched = statements.filter((row) => /^UPDATE (hostel_properties|hostel_listings)/.test(row.sql));
  assert.deepEqual(touched, [], "KYC decides money, never what a landlord may build or list");
});

test("the landlord queue puts the waiting first and names who decides", async () => {
  const queue = await listHostelLandlordsForStaff();
  assert.deepEqual(queue.map((landlord) => landlord.id), ["landlord-pending", "landlord-verified"], "pending landlords come before verified ones");
  assert.equal(queue[0].phone, "0551234567", "staff need the number the decision is made against");
  const response = await landlordsRoute.GET(request("/api/console/hostel/landlords", { cookie: await cookieFor("acc-admin") }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.landlords.length, 2);
});

test("the landlord KYC route is staff-only and validates its input", async () => {
  const signedOut = await landlordsRoute.GET(request("/api/console/hostel/landlords"));
  assert.equal(signedOut.status, 401);
  const forbidden = await landlordsRoute.GET(request("/api/console/hostel/landlords", { cookie: await cookieFor("acc-org") }));
  assert.equal(forbidden.status, 403);

  const cookie = await cookieFor("acc-admin");
  const noLandlord = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", { method: "PATCH", cookie, body: { action: "VERIFY_KYC" } }));
  assert.equal(noLandlord.status, 400);
  const badAction = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", { method: "PATCH", cookie, body: { landlordId: "landlord-pending", action: "APPROVE" } }));
  assert.equal(badAction.status, 400);
  const missing = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", { method: "PATCH", cookie, body: { landlordId: "landlord-nope", action: "VERIFY_KYC" } }));
  assert.equal(missing.status, 404);
  const alreadyVerified = await landlordsRoute.PATCH(request("/api/console/hostel/landlords", { method: "PATCH", cookie, body: { landlordId: "landlord-verified", action: "VERIFY_KYC" } }));
  assert.equal(alreadyVerified.status, 409, "a verified landlord is not re-verified for nothing");
});

/**
 * The two-party notices. A provider is told the decision that was made about
 * them, in one voice, from the shared notice book: the template id says which
 * service and which decision, and the reference is the provider, so a decision
 * repeated cannot send the same message twice.
 */
test("approving, rejecting or suspending an organizer tells the organizer", async () => {
  notices.length = 0;
  organizers.push({
    id: "org-pending", name: "New Applicant", phone: "0551112222", email: "applicant@example.com", organization: "Applicant Travel",
    status: "PENDING", kyc_status: "PENDING", kyc_reason: "", commission_bps: 300,
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
  });
  const cookie = await cookieFor("acc-admin");
  const decide = (body) => organizersRoute.PATCH(request("/api/console/organizers", { method: "PATCH", cookie, body }));

  const approved = await decide({ organizerId: "org-pending", action: "APPROVE" });
  assert.equal(approved.status, 200);
  assert.deepEqual(notices.map((row) => row.template), ["organizer_application_approved"]);
  assert.equal(notices[0].recipient, "applicant@example.com", "the applicant is the recipient, not the administrator");
  assert.equal(notices[0].reference, "org-pending", "the reference is the provider, so a repeat decision cannot send twice");
  assert.match(notices[0].subject, /approved/i);
  assert.match(notices[0].message, /payout account/i, "an approved organizer is told the next step");

  notices.length = 0;
  const rejected = await decide({ organizerId: "org-pending", action: "REJECT", reason: "The phone number does not reach you" });
  assert.equal(rejected.status, 200);
  assert.deepEqual(notices.map((row) => row.template), ["organizer_application_rejected"]);
  assert.match(notices[0].message, /The phone number does not reach you/, "a rejection carries the reason, or it is a dead end");

  notices.length = 0;
  const suspended = await decide({ organizerId: "org-pending", action: "SUSPEND", reason: "Repeated no-shows" });
  assert.equal(suspended.status, 200);
  assert.deepEqual(notices.map((row) => row.template), ["organizer_application_suspended"]);
  assert.match(notices[0].message, /Sign-in is closed/, "a suspended provider is told what changed for them");
});

test("a KYC decision tells the organizer, and the money gate says what to fix", async () => {
  notices.length = 0;
  const cookie = await cookieFor("acc-admin");

  const verified = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH", cookie, body: { organizerId: "org-a", action: "VERIFY_KYC" },
  }));
  assert.equal(verified.status, 200);
  assert.deepEqual(notices.map((row) => row.template), ["organizer_kyc_verified"]);
  assert.match(notices[0].message, /payments can be sent/i);

  notices.length = 0;
  const rejected = await organizersRoute.PATCH(request("/api/console/organizers", {
    method: "PATCH", cookie, body: { organizerId: "org-a", action: "REJECT_KYC", reason: "The ID photo is unreadable" },
  }));
  assert.equal(rejected.status, 200);
  assert.deepEqual(notices.map((row) => row.template), ["organizer_kyc_rejected"]);
  assert.match(notices[0].message, /The ID photo is unreadable/);
  assert.match(notices[0].subject, /could not verify/i);
});
