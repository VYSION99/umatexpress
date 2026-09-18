import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Phase 3's acceptance criteria are the publishing rules: a trip is invisible
 * until it is reviewed, an edit to a live trip re-enters review, an organizer
 * can only touch their own trips, and payout details are stored sealed and read
 * back masked unless an admin performs an audited reveal.
 */

process.env.TURSO_DATABASE_URL = "https://organizer-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-chars";

const SCHEMA_VERSION = "2026-09-18.2";
const ACCOUNT_COLUMNS = ["id", "email", "name", "phone", "role", "status", "profile_id"];

const accounts = [
  { id: "acc-a", email: "a@example.com", name: "Organizer A", phone: "0200000001", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-a", token_version: 0 },
  { id: "acc-b", email: "b@example.com", name: "Organizer B", phone: "0200000002", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-b", token_version: 0 },
  { id: "acc-mod", email: "mod@example.com", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-admin", email: "admin@example.com", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "", token_version: 0 },
];

const trips = [
  // A pre-existing platform trip: owned by nobody and already live.
  { id: "trip-pub", title: "Platform to Accra", route_from: "UMaT", route_to: "Accra", travel_date: "2026-09-05", departure_time: "06:30", arrival_time: "11:30", price: 180, capacity: 50, coach_type: "VIP Coach", organizer_id: "", review_status: "APPROVED", active: 1, archived: 0 },
];

const organizers = [
  { id: "org-a", name: "Organizer A", phone: "0200000001", email: "a@example.com", organization: "A Travel", status: "APPROVED", kyc_status: "PENDING", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: "org-b", name: "Organizer B", phone: "0200000002", email: "b@example.com", organization: "B Travel", status: "APPROVED", kyc_status: "PENDING", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
];

const profiles = new Map(organizers.map((organizer) => [organizer.id, {
  id: organizer.id, kyc_status: "PENDING", kyc_id_type: "", kyc_id_number: "", kyc_reason: "",
  kyc_submitted_at: "", kyc_reviewed_at: "", payout_method: "", payout_account_name: "",
  payout_account_number: "", payout_account_last4: "", payout_updated_at: "", paystack_recipient_code: "",
}]));

const statements = [];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: "integer", value: String(value) };
  return { type: "text", value: String(value) };
}

function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}

const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });

function handle(sql, args) {
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta|^INSERT INTO admin_audit_logs/.test(sql)) return ok(empty);
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) return ok(table(["version"], [{ version: SCHEMA_VERSION }]));
  if (/AS token_version FROM console_accounts/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(["token_version"], [account]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(ACCOUNT_COLUMNS, [account]) : empty);
  }
  if (/FROM scheduled_trips WHERE id = \? AND organizer_id = \? LIMIT 1/.test(sql)) {
    const trip = trips.find((item) => item.id === args[0] && item.organizer_id === args[1]);
    return ok(trip ? table(["id", "review_status"], [trip]) : empty);
  }
  if (/^SELECT id,organizer_id,review_status FROM scheduled_trips WHERE id = \? LIMIT 1/.test(sql)) {
    const trip = trips.find((item) => item.id === args[0]);
    return ok(trip ? table(["id", "organizer_id", "review_status"], [trip]) : empty);
  }
  if (/FROM scheduled_trips t LEFT JOIN trip_organizers o/.test(sql)) {
    const pending = trips.filter((trip) => trip.review_status === "PENDING_REVIEW" && !trip.archived);
    return ok(table(
      ["id", "title", "route_from", "route_to", "travel_date", "departure_time", "arrival_time", "price", "capacity", "coach_type", "review_status", "organizer_id", "submitted_at", "organization", "organizer_name"],
      pending.map((trip) => {
        const owner = organizers.find((item) => item.id === trip.organizer_id);
        return { ...trip, submitted_at: "2026-09-10T00:00:00.000Z", organization: owner?.organization || "", organizer_name: owner?.name || "" };
      }),
    ));
  }
  if (/FROM trip_organizers o LEFT JOIN console_accounts a/.test(sql)) {
    const match = /WHERE o\.id = \?/.test(sql) ? organizers.filter((item) => item.id === args[0]) : organizers;
    return ok(table(
      ["id", "name", "phone", "email", "organization", "status", "kyc_status", "commission_bps", "created_at", "updated_at", "account_id", "account_status"],
      match.map((item) => ({ ...item, kyc_status: profiles.get(item.id)?.kyc_status || item.kyc_status, account_id: "", account_status: "" })),
    ));
  }
  if (/FROM scheduled_trips t WHERE t\.organizer_id = \?/.test(sql)) {
    const owned = trips.filter((item) => item.organizer_id === args[0]);
    return ok(table(
      ["id", "title", "route_from", "route_to", "travel_date", "departure_time", "arrival_time", "price", "capacity", "coach_type", "tag", "amenities", "notes", "review_status", "archived", "review_reason", "booking_count", "confirmed_count"],
      owned.map((trip) => ({ ...trip, price: Number(trip.price), booking_count: 0, confirmed_count: 0 })),
    ));
  }
  if (/^SELECT COALESCE\(payout_account_number/.test(sql)) {
    const profile = profiles.get(args[0]);
    return ok(profile ? table(["payout_account_number", "kyc_id_number"], [profile]) : empty);
  }
  if (/^SELECT id,COALESCE\(kyc_status/.test(sql)) {
    const profile = profiles.get(args[0]);
    return ok(profile ? table(Object.keys(profile), [profile]) : empty);
  }
  if (/^INSERT INTO scheduled_trips/.test(sql)) {
    trips.push({
      id: args[0], title: args[1], route_from: args[2], route_to: args[3], travel_date: args[4],
      departure_time: args[5], arrival_time: args[6], price: Number(args[7]), capacity: Number(args[8]),
      coach_type: args[9], tag: args[10], amenities: args[11], notes: args[12],
      organizer_id: args[13], review_status: "DRAFT", active: 0, archived: 0, review_reason: "",
    });
    return ok(empty);
  }
  if (/^UPDATE scheduled_trips SET review_status='PENDING_REVIEW'/.test(sql)) {
    const trip = trips.find((item) => item.id === args[args.length - 1]);
    if (trip) trip.review_status = "PENDING_REVIEW";
    return ok(empty);
  }
  if (/^UPDATE scheduled_trips SET review_status=\?,\s*review_reason=\?/.test(sql)) {
    const trip = trips.find((item) => item.id === args[args.length - 1]);
    if (trip) {
      trip.review_status = String(args[0]);
      trip.active = Number(args[4]);
      if (String(args[0]) === "APPROVED") trip.archived = 0;
    }
    return ok(empty);
  }
  if (/^UPDATE scheduled_trips SET title=\?/.test(sql)) {
    const trip = trips.find((item) => item.id === args[15] && item.organizer_id === args[16]);
    if (trip) {
      trip.title = args[0];
      trip.review_status = String(args[12]);
      trip.active = Number(args[13]);
    }
    return ok(empty);
  }
  if (/^UPDATE scheduled_trips SET archived = 1/.test(sql)) {
    const trip = trips.find((item) => item.id === args[1] && item.organizer_id === args[2]);
    if (trip) {
      trip.archived = 1;
      trip.active = 0;
    }
    return ok(empty);
  }
  if (/^UPDATE trip_organizers SET kyc_id_type=\?/.test(sql)) {
    const profile = profiles.get(args[4]);
    if (profile) {
      profile.kyc_id_type = String(args[0]);
      profile.kyc_id_number = String(args[1]);
      profile.kyc_status = "PENDING";
      profile.kyc_reason = "";
    }
    return ok(empty);
  }
  if (/^UPDATE trip_organizers SET payout_method=\?/.test(sql)) {
    const profile = profiles.get(args[6]);
    if (profile) {
      profile.payout_method = String(args[0]);
      profile.payout_account_name = String(args[1]);
      profile.payout_account_number = String(args[2]);
      profile.payout_account_last4 = String(args[3]);
    }
    return ok(empty);
  }
  if (/^UPDATE trip_organizers SET kyc_status=\?,kyc_reason=\?/.test(sql)) {
    const profile = profiles.get(args[4]);
    if (profile) {
      profile.kyc_status = String(args[0]);
      profile.kyc_reason = String(args[1]);
    }
    return ok(empty);
  }
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
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const { CONSOLE_SESSION_COOKIE, createConsoleSession } = await vite.ssrLoadModule("/lib/console-auth.ts");
const tripsRoute = await vite.ssrLoadModule("/app/api/console/trips/route.ts");
const tripRoute = await vite.ssrLoadModule("/app/api/console/trips/[tripId]/route.ts");
const reviewRoute = await vite.ssrLoadModule("/app/api/console/trips/[tripId]/review/route.ts");
const queueRoute = await vite.ssrLoadModule("/app/api/console/trips/review/route.ts");
const profileRoute = await vite.ssrLoadModule("/app/api/console/organizers/profile/route.ts");
const kycRoute = await vite.ssrLoadModule("/app/api/console/organizers/profile/kyc/route.ts");
const payoutRoute = await vite.ssrLoadModule("/app/api/console/organizers/profile/payout/route.ts");
const revealRoute = await vite.ssrLoadModule("/app/api/console/organizers/reveal/route.ts");
const organizersRoute = await vite.ssrLoadModule("/app/api/console/organizers/route.ts");

const URL_BASE = "https://console.example.test";
const params = (tripId) => ({ params: Promise.resolve({ tripId }) });
const validTrip = (title = "Accra weekend") => ({
  title, from: "UMaT", to: "Accra", travelDate: "2026-10-03",
  departureTime: "06:30", arrivalTime: "11:30", price: 180, capacity: 45, coachType: "VIP Coach",
  tag: "Weekend", amenities: ["Wi-Fi"], notes: "",
});

async function cookieFor(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id: account.id, role: account.role }))}`;
}

async function createTrip(cookie, title) {
  const response = await tripsRoute.POST(new Request(`${URL_BASE}/api/console/trips`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(validTrip(title)),
  }));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.trip.id;
}

async function review(cookie, tripId, action, reason) {
  return reviewRoute.PATCH(new Request(`${URL_BASE}/api/console/trips/${tripId}/review`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action, reason }),
  }), params(tripId));
}

test("a created trip is a draft and cannot be booked", async () => {
  statements.length = 0;
  const response = await tripsRoute.POST(new Request(`${URL_BASE}/api/console/trips`, {
    method: "POST",
    headers: { cookie: await cookieFor("acc-a"), "content-type": "application/json" },
    body: JSON.stringify(validTrip("Draft run")),
  }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.trip.reviewStatus, "DRAFT");

  const insert = statements.find((entry) => /^INSERT INTO scheduled_trips/.test(entry.sql));
  assert.equal(insert.args[13], "org-a", "the owner is the session's profile, never a body field");
  assert.match(insert.sql, /0,0,0,\?,'DRAFT'/, "active and archived must be written off");
});

test("an organizer cannot touch, submit or remove another organizer's trip", async () => {
  const owner = await cookieFor("acc-a");
  const tripId = await createTrip(owner, "Private run");
  const intruder = await cookieFor("acc-b");

  for (const attempt of [
    () => tripRoute.PATCH(new Request(`${URL_BASE}/api/console/trips/${tripId}`, {
      method: "PATCH", headers: { cookie: intruder, "content-type": "application/json" }, body: JSON.stringify(validTrip("Hijacked")),
    }), params(tripId)),
    () => tripRoute.DELETE(new Request(`${URL_BASE}/api/console/trips/${tripId}`, { method: "DELETE", headers: { cookie: intruder } }), params(tripId)),
    () => review(intruder, tripId, "SUBMIT"),
  ]) {
    statements.length = 0;
    const response = await attempt();
    assert.equal(response.status, 404, "another organizer's trip must look missing, not forbidden");
    assert.equal(statements.some((entry) => /^(UPDATE|DELETE) /.test(entry.sql)), false);
  }
});

test("submit routes a draft to the queue, and a moderator's approval publishes it", async () => {
  const owner = await cookieFor("acc-a");
  const tripId = await createTrip(owner, "Queue run");

  statements.length = 0;
  const submitted = await review(owner, tripId, "SUBMIT");
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).trip.reviewStatus, "PENDING_REVIEW");
  const submit = statements.find((entry) => /^UPDATE scheduled_trips SET review_status='PENDING_REVIEW'/.test(entry.sql));
  assert.match(submit.sql, /review_status='PENDING_REVIEW'/);
  assert.doesNotMatch(submit.sql, /active/, "submitting must never make a trip bookable");

  const queue = await queueRoute.GET(new Request(`${URL_BASE}/api/console/trips/review`, { headers: { cookie: await cookieFor("acc-mod") } }));
  const queued = await queue.json();
  assert.equal(queue.status, 200);
  const entry = queued.trips.find((trip) => trip.id === tripId);
  assert.equal(entry.organizerName, "A Travel");
  assert.equal(entry.platformOwned, false);

  statements.length = 0;
  const approved = await review(await cookieFor("acc-mod"), tripId, "APPROVE");
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).trip.reviewStatus, "APPROVED");
  const decision = statements.find((entry) => /^UPDATE scheduled_trips SET review_status=\?,\s*review_reason=\?/.test(entry.sql));
  assert.equal(decision.args[0], "APPROVED");
  assert.equal(Number(decision.args[4]), 1, "approval turns active on in the same statement");
});

test("editing a live trip sends it back for review", async () => {
  const owner = await cookieFor("acc-a");
  const tripId = await createTrip(owner, "Live run");
  await review(owner, tripId, "SUBMIT");
  await review(await cookieFor("acc-mod"), tripId, "APPROVE");

  statements.length = 0;
  const edited = await tripRoute.PATCH(new Request(`${URL_BASE}/api/console/trips/${tripId}`, {
    method: "PATCH",
    headers: { cookie: owner, "content-type": "application/json" },
    body: JSON.stringify({ ...validTrip("Live run"), price: 200 }),
  }), params(tripId));
  const body = await edited.json();
  assert.equal(edited.status, 200);
  assert.equal(body.trip.reviewStatus, "PENDING_REVIEW");
  const update = statements.find((entry) => /^UPDATE scheduled_trips SET title=\?/.test(entry.sql));
  assert.equal(update.args[12], "PENDING_REVIEW");
  assert.equal(Number(update.args[13]), 0, "a trip back in review must not stay bookable");
});

test("the trip list round-trips the fields the edit form reuses", async () => {
  const owner = await cookieFor("acc-a");
  const response = await tripsRoute.POST(new Request(`${URL_BASE}/api/console/trips`, {
    method: "POST",
    headers: { cookie: owner, "content-type": "application/json" },
    body: JSON.stringify({ ...validTrip("Round-trip run"), tag: "Weekend", amenities: ["Wi-Fi", "AC"], notes: "Departure from the main gate" }),
  }));
  const created = await response.json();

  const list = await tripsRoute.GET(new Request(`${URL_BASE}/api/console/trips`, { headers: { cookie: owner } }));
  const body = await list.json();
  const trip = body.trips.find((item) => item.id === created.trip.id);
  assert.deepEqual(trip.amenities, ["Wi-Fi", "AC"], "an edit must not silently reset amenities to the default");
  assert.equal(trip.tag, "Weekend");
  assert.equal(trip.notes, "Departure from the main gate");
});

test("rejections need a reason and only leave review", async () => {
  const owner = await cookieFor("acc-a");
  const admin = await cookieFor("acc-admin");
  const tripId = await createTrip(owner, "Rejected run");
  await review(owner, tripId, "SUBMIT");

  const noReason = await review(admin, tripId, "REJECT");
  assert.equal(noReason.status, 400);

  const rejected = await review(admin, tripId, "REJECT", "Fare looks wrong");
  const body = await rejected.json();
  assert.equal(rejected.status, 200);
  assert.equal(body.trip.reviewStatus, "REJECTED");

  const draftId = await createTrip(owner, "Still draft");
  assert.equal((await review(admin, draftId, "APPROVE")).status, 409, "a draft was never submitted, so there is nothing to approve");
});

test("KYC is captured sealed, verified by staff, and never returned in the clear", async () => {
  const owner = await cookieFor("acc-a");
  statements.length = 0;
  const saved = await kycRoute.PUT(new Request(`${URL_BASE}/api/console/organizers/profile/kyc`, {
    method: "PUT",
    headers: { cookie: owner, "content-type": "application/json" },
    body: JSON.stringify({ idType: "GHANA_CARD", idNumber: "1234567890" }),
  }));
  const body = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(body.profile.kycStatus, "PENDING");
  assert.equal(body.profile.kycIdNumberMasked, "••••7890");
  assert.equal(JSON.stringify(body).includes("1234567890"), false, "the full number must never leave the server");

  const write = statements.find((entry) => /^UPDATE trip_organizers SET kyc_id_type=\?/.test(entry.sql));
  assert.match(String(write.args[1]), /^v1:/, "the stored value must be sealed");

  const staff = await cookieFor("acc-mod");
  const missingReason = await organizersRoute.PATCH(new Request(`${URL_BASE}/api/console/organizers`, {
    method: "PATCH", headers: { cookie: staff, "content-type": "application/json" },
    body: JSON.stringify({ organizerId: "org-a", action: "REJECT_KYC" }),
  }));
  assert.equal(missingReason.status, 400);

  const verified = await organizersRoute.PATCH(new Request(`${URL_BASE}/api/console/organizers`, {
    method: "PATCH", headers: { cookie: staff, "content-type": "application/json" },
    body: JSON.stringify({ organizerId: "org-a", action: "VERIFY_KYC" }),
  }));
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).organizer.kycStatus, "VERIFIED");
});

test("payout details are stored sealed, read masked, and only an admin may reveal them", async () => {
  const owner = await cookieFor("acc-a");
  statements.length = 0;
  const saved = await payoutRoute.PUT(new Request(`${URL_BASE}/api/console/organizers/profile/payout`, {
    method: "PUT",
    headers: { cookie: owner, "content-type": "application/json" },
    body: JSON.stringify({ method: "MOMO", accountName: "A Travel", accountNumber: "0244123456" }),
  }));
  const body = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(body.profile.payoutAccountMasked, "••••3456");
  assert.equal(JSON.stringify(body).includes("0244123456"), false);

  const write = statements.find((entry) => /^UPDATE trip_organizers SET payout_method=\?/.test(entry.sql));
  assert.match(String(write.args[2]), /^v1:/, "the account number must be sealed at rest");
  assert.equal(write.args[3], "3456", "only the last four are stored in the clear");
  const savedAudit = statements.find((entry) => /^INSERT INTO admin_audit_logs/.test(entry.sql));
  assert.equal(JSON.stringify(savedAudit.args).includes("0244123456"), false, "the audit trail must not hold the number");

  const profile = await profileRoute.GET(new Request(`${URL_BASE}/api/console/organizers/profile`, { headers: { cookie: owner } }));
  const profileBody = await profile.json();
  assert.equal(profileBody.profile.payoutAccountMasked, "••••3456");
  assert.equal(JSON.stringify(profileBody).includes("0244123456"), false);

  assert.equal((await revealRoute.POST(new Request(`${URL_BASE}/api/console/organizers/reveal`, {
    method: "POST", headers: { cookie: await cookieFor("acc-mod"), "content-type": "application/json" }, body: JSON.stringify({ organizerId: "org-a" }),
  }))).status, 403, "a moderator may not open a payout account");
  assert.equal((await revealRoute.POST(new Request(`${URL_BASE}/api/console/organizers/reveal`, {
    method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ organizerId: "org-a" }),
  }))).status, 403, "an organizer may not read anyone's full record, including their own");

  statements.length = 0;
  const revealed = await revealRoute.POST(new Request(`${URL_BASE}/api/console/organizers/reveal`, {
    method: "POST",
    headers: { cookie: await cookieFor("acc-admin"), "content-type": "application/json" },
    body: JSON.stringify({ organizerId: "org-a" }),
  }));
  const revealedBody = await revealed.json();
  assert.equal(revealed.status, 200);
  assert.equal(revealedBody.revealed.payoutAccountNumber, "0244123456");
  assert.equal(revealedBody.revealed.kycIdNumber, "1234567890");
  const audit = statements.find((entry) => /^INSERT INTO admin_audit_logs/.test(entry.sql) && entry.args[2] === "ORGANIZER_PROFILE_REVEALED");
  assert.ok(audit, "a reveal must write an audit row naming the actor");
  assert.equal(audit.args[1], "admin@example.com");
});

test("suspending a live trip is an admin action, and it survives an organizer edit", async () => {
  const owner = await cookieFor("acc-a");
  const tripId = await createTrip(owner, "Suspend run");
  await review(owner, tripId, "SUBMIT");
  await review(await cookieFor("acc-mod"), tripId, "APPROVE");

  statements.length = 0;
  const refused = await review(await cookieFor("acc-mod"), tripId, "SUSPEND", "Complaint");
  assert.equal(refused.status, 403);
  assert.equal(statements.some((entry) => /^UPDATE scheduled_trips SET review_status=\?/.test(entry.sql)), false);

  const suspended = await review(await cookieFor("acc-admin"), tripId, "SUSPEND", "Complaint");
  assert.equal(suspended.status, 200);
  assert.equal((await suspended.json()).trip.reviewStatus, "SUSPENDED");

  // A suspended trip is still the organizer's to resubmit, and resubmission
  // returns it to the queue rather than straight back to live.
  const resubmitted = await review(owner, tripId, "SUBMIT");
  assert.equal((await resubmitted.json()).trip.reviewStatus, "PENDING_REVIEW");
});
