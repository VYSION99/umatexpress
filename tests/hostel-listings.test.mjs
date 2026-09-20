import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * M3: the academic-year catalogue, the listing lifecycle and the review that
 * decides what students may see. The routes run against a fake Turso that
 * records every statement, so the tests assert on the arguments a query was
 * actually given — including the owner id bound into every landlord query.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-listings-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";

const accounts = [];
const landlords = [];
const properties = [];
const rooms = [];
const spaces = [];
const periods = [];
const listings = [];
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

const LISTING_ROW_COLUMNS = [
  "id", "space_id", "period_id", "price", "status", "review_reason", "submitted_at", "reviewed_at", "reviewed_by", "created_at", "updated_at",
  "space_status", "room_status", "room_label", "space_label", "property_id", "property_name", "property_status",
  "period_name", "period_starts_on", "period_active", "utilities_enabled", "utilities_fee", "capacity",
  "landlord_id", "landlord_name", "landlord_phone", "landlord_kyc_status",
];
const PERIOD_ROW_COLUMNS = ["id", "name", "starts_on", "ends_on", "active", "created_at"];
const PROPERTY_ROW_COLUMNS = ["id", "landlord_id", "name", "address", "latitude", "longitude", "utilities_enabled", "status", "created_at", "updated_at"];

/** One listing joined to everything the views read, built from the live state. */
function listingRow(listing) {
  const space = spaces.find((item) => item.id === listing.space_id) || {};
  const room = rooms.find((item) => item.id === space.room_id) || {};
  const property = properties.find((item) => item.id === room.property_id) || {};
  const period = periods.find((item) => item.id === listing.period_id) || {};
  const landlord = landlords.find((item) => item.id === property.landlord_id) || {};
  return {
    ...listing,
    space_status: space.status || "AVAILABLE",
    room_status: room.status || "ACTIVE",
    room_label: room.label || "",
    space_label: space.label || "",
    property_id: property.id || "",
    property_name: property.name || "",
    property_status: property.status || "DRAFT",
    period_name: period.name || "",
    period_starts_on: period.starts_on || "",
    period_active: period.active ?? 0,
    utilities_enabled: property.utilities_enabled ?? 0,
    utilities_fee: room.utilities_fee ?? 0,
    capacity: room.capacity ?? 0,
    landlord_id: landlord.id || "",
    landlord_name: landlord.organization || landlord.name || "",
    landlord_phone: landlord.phone || "",
    landlord_kyc_status: landlord.kyc_status || "PENDING",
  };
}

function handle(sql, args) {
  // --- console session plumbing -------------------------------------------
  if (/SELECT COALESCE\(token_version,0\) AS token_version FROM console_accounts/.test(sql)) {
    const row = accounts.find((item) => item.id === args[0]);
    return ok(row ? table(["token_version"], [{ token_version: 0 }]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const row = accounts.find((item) => item.id === args[0]);
    return ok(row ? table(["id", "email", "name", "phone", "role", "status", "profile_id"], [row]) : empty);
  }

  // --- periods -------------------------------------------------------------
  if (/FROM hostel_periods WHERE id = \? AND COALESCE\(active,1\) = 1 LIMIT 1/.test(sql)) {
    return ok(table(PERIOD_ROW_COLUMNS, periods.filter((item) => item.id === args[0] && item.active === 1)));
  }
  if (/FROM hostel_periods WHERE COALESCE\(active,1\) = 1 AND starts_on <= \? AND ends_on >= \? LIMIT 1/.test(sql)) {
    const rows = periods.filter((item) => item.active === 1 && item.starts_on <= args[0] && item.ends_on >= args[1]);
    return ok(rows.length ? table(["id", "name"], rows) : empty);
  }
  if (/FROM hostel_periods WHERE COALESCE\(active,1\) = 1 ORDER BY starts_on DESC LIMIT 1/.test(sql)) {
    const rows = periods.filter((item) => item.active === 1).sort((left, right) => right.starts_on.localeCompare(left.starts_on)).slice(0, 1);
    return ok(table(PERIOD_ROW_COLUMNS, rows));
  }
  if (/FROM hostel_periods WHERE COALESCE\(active,1\) = 1 ORDER BY starts_on DESC/.test(sql)) {
    const rows = periods.filter((item) => item.active === 1).sort((left, right) => right.starts_on.localeCompare(left.starts_on));
    return ok(table(PERIOD_ROW_COLUMNS, rows));
  }
  if (/FROM hostel_periods\s+ORDER BY starts_on DESC/.test(sql)) {
    return ok(table(PERIOD_ROW_COLUMNS, [...periods].sort((left, right) => right.starts_on.localeCompare(left.starts_on))));
  }
  if (/FROM hostel_periods WHERE id = \? LIMIT 1/.test(sql)) {
    return ok(table(PERIOD_ROW_COLUMNS, periods.filter((item) => item.id === args[0])));
  }
  if (/INSERT INTO hostel_periods/.test(sql)) {
    const [id, name, startsOn, endsOn, createdAt] = args;
    periods.push({ id, name, starts_on: startsOn, ends_on: endsOn, active: 1, created_at: createdAt });
    return ok();
  }
  if (/^UPDATE hostel_periods SET active = 0 WHERE id = \?/.test(sql)) {
    const row = periods.find((item) => item.id === args[0]);
    if (row) row.active = 0;
    return ok();
  }

  // --- listings ------------------------------------------------------------
  if (/^SELECT s\.id AS space_id/.test(sql)) {
    const space = spaces.find((item) => item.id === args[0]);
    const room = space && rooms.find((item) => item.id === space.room_id);
    const property = room && properties.find((item) => item.id === room.property_id && item.landlord_id === args[1]);
    return ok(property ? table(["space_id", "space_status", "room_label", "room_status"], [{
      space_id: space.id, space_status: space.status, room_label: room.label, room_status: room.status,
    }]) : empty);
  }
  if (/FROM hostel_listings WHERE space_id = \? AND period_id = \? LIMIT 1/.test(sql)) {
    const row = listings.find((item) => item.space_id === args[0] && item.period_id === args[1]);
    return ok(row ? table(["id", "status"], [row]) : empty);
  }
  if (/INSERT INTO hostel_listings/.test(sql)) {
    const [id, spaceId, periodId, price, createdAt, updatedAt] = args;
    listings.push({ id, space_id: spaceId, period_id: periodId, price: Number(price), status: "DRAFT", review_reason: "", submitted_at: "", reviewed_at: "", reviewed_by: "", created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/^SELECT l\.id AS listing_id/.test(sql)) {
    // The public read: only approved beds, with the property filter when asked.
    const wantsProperty = /AND p\.id = \?/.test(sql);
    const rows = listings
      .filter((item) => item.period_id === args[0] && item.status === "APPROVED")
      .map(listingRow)
      .filter((row) => row.space_status !== "RETIRED" && row.room_status === "ACTIVE" && row.property_status !== "SUSPENDED")
      .filter((row) => !wantsProperty || row.property_id === args[1]);
    return ok(table(["listing_id", "space_id", "room_label", "space_label", "capacity", "price", "utilities_fee", "utilities_enabled"], rows.map((row) => ({
      listing_id: row.id, space_id: row.space_id, room_label: row.room_label, space_label: row.space_label,
      capacity: row.capacity, price: row.price, utilities_fee: row.utilities_fee, utilities_enabled: row.utilities_enabled,
    }))));
  }
  if (/WHERE l\.id = \? AND p\.landlord_id = \? LIMIT 1/.test(sql)) {
    const listing = listings.find((item) => item.id === args[0]);
    const row = listing && listingRow(listing);
    return ok(row && row.property_status && properties.find((item) => item.id === row.property_id && item.landlord_id === args[1]) ? table(LISTING_ROW_COLUMNS, [row]) : empty);
  }
  if (/WHERE p\.id = \? AND p\.landlord_id = \?/.test(sql)) {
    const owned = properties.find((item) => item.id === args[0] && item.landlord_id === args[1]);
    if (!owned) return ok(empty);
    const rows = listings.filter((item) => listingRow(item).property_id === args[0]).map(listingRow);
    return ok(table(LISTING_ROW_COLUMNS, rows));
  }
  if (/WHERE l\.status = \?/.test(sql)) {
    const rows = listings.filter((item) => item.status === args[0]).map(listingRow);
    return ok(table(LISTING_ROW_COLUMNS, rows));
  }
  if (/WHERE l\.id = \? LIMIT 1/.test(sql)) {
    const listing = listings.find((item) => item.id === args[0]);
    return ok(listing ? table(LISTING_ROW_COLUMNS, [listingRow(listing)]) : empty);
  }
  if (/^UPDATE hostel_listings SET price=\?,status=\?,review_reason=\?,updated_at=\?/.test(sql)) {
    const [price, status, reviewReason, updatedAt, id] = args;
    const row = listings.find((item) => item.id === id);
    if (row) Object.assign(row, { price: Number(price), status, review_reason: reviewReason, updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_listings SET status='PENDING_REVIEW'/.test(sql)) {
    const [submittedAt, updatedAt, id] = args;
    const row = listings.find((item) => item.id === id);
    if (row) Object.assign(row, { status: "PENDING_REVIEW", submitted_at: submittedAt, review_reason: "", updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_listings SET status=\?,review_reason=\?,reviewed_at=\?,reviewed_by=\?,updated_at=\?/.test(sql)) {
    const [status, reviewReason, reviewedAt, reviewedBy, updatedAt, id] = args;
    const row = listings.find((item) => item.id === id);
    if (row) Object.assign(row, { status, review_reason: reviewReason, reviewed_at: reviewedAt, reviewed_by: reviewedBy, updated_at: updatedAt });
    return ok();
  }
  if (/^DELETE FROM hostel_listings WHERE id = \? AND space_id = \?/.test(sql)) {
    const index = listings.findIndex((item) => item.id === args[0] && item.space_id === args[1]);
    if (index >= 0) listings.splice(index, 1);
    return ok();
  }
  if (/^UPDATE hostel_properties SET status='APPROVED',updated_at=\? WHERE id = \?/.test(sql)) {
    const row = properties.find((item) => item.id === args[1]);
    if (row) Object.assign(row, { status: "APPROVED", updated_at: args[0] });
    return ok();
  }
  if (/INSERT INTO hostel_properties/.test(sql)) {
    const [id, landlordId, name, address, latitude, longitude, utilitiesEnabled, createdAt, updatedAt] = args;
    properties.push({
      id, landlord_id: landlordId, name, address,
      latitude: latitude === null ? null : Number(latitude),
      longitude: longitude === null ? null : Number(longitude),
      utilities_enabled: Number(utilitiesEnabled), status: "DRAFT", created_at: createdAt, updated_at: updatedAt,
    });
    return ok();
  }
  if (/^SELECT id FROM hostel_rooms WHERE property_id = \? AND label = \? AND status = 'ACTIVE' LIMIT 1/.test(sql)) {
    const row = rooms.find((item) => item.property_id === args[0] && item.label === args[1] && item.status === "ACTIVE");
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/INSERT INTO hostel_rooms/.test(sql)) {
    const [id, propertyId, label, capacity, utilitiesFee, amenities, createdAt, updatedAt] = args;
    rooms.push({ id, property_id: propertyId, label, capacity: Number(capacity), utilities_fee: Number(utilitiesFee), amenities, status: "ACTIVE", created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/INSERT INTO hostel_spaces/.test(sql)) {
    const [id, roomId, label, createdAt, updatedAt] = args;
    spaces.push({ id, room_id: roomId, label, status: "AVAILABLE", created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/^SELECT r\.id,r\.property_id,r\.label/.test(sql)) {
    const room = rooms.find((item) => item.id === args[0]);
    const owned = room && properties.find((item) => item.id === room.property_id && item.landlord_id === args[1]);
    return ok(owned ? table(["id", "property_id", "label", "capacity", "utilities_fee", "amenities", "status", "created_at", "updated_at"], [room]) : empty);
  }
  if (/^SELECT s\.id,s\.room_id,s\.label.*FROM hostel_spaces s WHERE s\.room_id = \? ORDER BY/.test(sql)) {
    return ok(table(["id", "room_id", "label", "status", "created_at", "updated_at"], spaces.filter((item) => item.room_id === args[0])));
  }
  if (/FROM hostel_properties WHERE id = \? AND landlord_id = \? LIMIT 1/.test(sql)) {
    const row = properties.find((item) => item.id === args[0] && item.landlord_id === args[1]);
    return ok(row ? table(PROPERTY_ROW_COLUMNS, [row]) : empty);
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
const { createHostelProperty, createHostelRoom } = await vite.ssrLoadModule("/lib/hostel-engine/landlord.ts");
const { closeHostelPeriod, createHostelPeriod, hostelReleaseAfter, listHostelPeriods } = await vite.ssrLoadModule("/lib/hostel-engine/periods.ts");
const {
  createHostelListing, getHostelListing, listHostelListingsForProperty, listHostelListingsForStaff,
  listPublicSpaces, removeHostelListing, reviewHostelListing, submitHostelListing, updateHostelListing,
} = await vite.ssrLoadModule("/lib/hostel-engine/listings.ts");
const publicPeriodsRoute = await vite.ssrLoadModule("/app/api/hostel/periods/route.ts");
const publicSpacesRoute = await vite.ssrLoadModule("/app/api/hostel/spaces/route.ts");
const adminPeriodsRoute = await vite.ssrLoadModule("/app/api/admin/hostel/periods/route.ts");
const listingsRoute = await vite.ssrLoadModule("/app/api/console/hostel/listings/route.ts");
const listingRoute = await vite.ssrLoadModule("/app/api/console/hostel/listings/[listingId]/route.ts");
const listingReviewRoute = await vite.ssrLoadModule("/app/api/console/hostel/listings/[listingId]/review/route.ts");
const staffQueueRoute = await vite.ssrLoadModule("/app/api/console/hostel/listings/review/route.ts");

accounts.push(
  { id: "acc-admin", email: "admin@umat.edu.gh", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "" },
  { id: "acc-mod", email: "mod@umat.edu.gh", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "" },
  { id: "acc-landlord", email: "owusu@example.com", name: "Mr. Owusu", phone: "0551234567", role: "LANDLORD", status: "ACTIVE", profile_id: "landlord-a" },
);
landlords.push(
  { id: "landlord-a", name: "Mr. Owusu", phone: "0551234567", email: "owusu@example.com", organization: "Owusu Hostels", status: "ACTIVE", kyc_status: "VERIFIED" },
  { id: "landlord-b", name: "Mr. Mensah", phone: "0559999999", email: "mensah@example.com", organization: "Mensah Lodge", status: "ACTIVE", kyc_status: "PENDING" },
);

async function cookieFor(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id: account.id, role: account.role }))}`;
}

const URL_BASE = "https://console.example.test";

/** A property, a room and `beds` beds for one landlord, all from the engine. */
let propertyCounter = 0;
async function buildProperty(landlordId, beds = 2, options = {}) {
  propertyCounter += 1;
  const property = await createHostelProperty(landlordId, {
    name: options.name || `Hostel ${propertyCounter}`,
    address: "Near UMaT main gate, Tarkwa",
    utilitiesEnabled: options.utilitiesEnabled !== false,
  });
  if (options.status) properties.find((item) => item.id === property.id).status = options.status;
  const room = await createHostelRoom(landlordId, property.id, { label: "Room 1", capacity: beds, utilitiesFee: 2000 });
  return { property, room, beds: room.spaces };
}

let periodCounter = 0;
/** A fresh open year per call, far enough out that no two tests collide. */
async function buildPeriod(overrides = {}) {
  periodCounter += 1;
  const start = 2100 + periodCounter;
  return createHostelPeriod("admin@umat.edu.gh", {
    name: overrides.name || `${start}/${start + 1} Academic Year`,
    startsOn: overrides.startsOn || `${start}-09-01`,
    endsOn: overrides.endsOn || `${start + 1}-06-30`,
  });
}

test("an academic year is created with the release date its reopening implies", async () => {
  statements.length = 0;
  const period = await buildPeriod({ name: "2030/31 Academic Year", startsOn: "2030-09-02", endsOn: "2031-06-30" });
  assert.equal(period.name, "2030/31 Academic Year");
  assert.equal(period.startsOn, "2030-09-02");
  assert.equal(period.active, true);

  const audit = statements.filter((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql)).at(-1);
  assert.equal(audit.args[2], "HOSTEL_PERIOD_CREATED");
  assert.match(String(audit.args[5]), /2030-08-30/, "the audit records the release date the year implies");

  const open = await listHostelPeriods();
  assert.ok(open.some((item) => item.id === period.id));
});

test("release timing is three days before school, and never under seven days after payment", () => {
  assert.equal(hostelReleaseAfter("2030-09-02"), "2030-08-30", "no confirmation yet: the reopening date rules");
  assert.equal(hostelReleaseAfter("2030-09-02", "2030-09-01T09:00:00.000Z"), "2030-09-08", "a booking made at the last minute keeps a real escrow window");
  assert.equal(hostelReleaseAfter("2030-09-02", "2029-11-01T09:00:00.000Z"), "2030-08-30", "an early booking is not held longer than the year requires");
  assert.throws(() => hostelReleaseAfter("not-a-date"), (error) => error?.code === "VALIDATION_ERROR");
});

test("overlapping open years are refused, and a closed year stops blocking", async () => {
  const first = await buildPeriod({ name: "2031/32 Academic Year", startsOn: "2031-09-01", endsOn: "2032-06-30" });
  const before = statements.length;
  await assert.rejects(
    () => createHostelPeriod("admin@umat.edu.gh", { name: "2031/32 Semester One", startsOn: "2031-10-01", endsOn: "2032-02-28" }),
    (error) => error?.code === "CONFLICT",
  );
  assert.deepEqual(statements.slice(before).filter((entry) => /INSERT INTO hostel_periods/.test(entry.sql)), [], "a refused year writes nothing");

  await closeHostelPeriod("admin@umat.edu.gh", first.id);
  const after = await buildPeriod({ name: "2031/32 Semester One", startsOn: "2031-10-01", endsOn: "2032-02-28" });
  assert.equal(after.active, true, "the same dates are free once the year they clashed with is closed");
});

test("year validation happens before the catalogue is touched", async () => {
  const before = statements.length;
  await assert.rejects(() => createHostelPeriod("admin@umat.edu.gh", { name: "26/27", startsOn: "2026-09-01", endsOn: "2027-06-30" }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => createHostelPeriod("admin@umat.edu.gh", { name: "2026/27 Academic Year", startsOn: "2027-06-30", endsOn: "2026-09-01" }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => createHostelPeriod("admin@umat.edu.gh", { name: "2026/27 Academic Year", startsOn: "01/09/2026", endsOn: "2027-06-30" }), (error) => error?.code === "VALIDATION_ERROR");
  assert.equal(statements.length, before, "no statement should leave the worker for invalid input");
});

test("a landlord prices one of their own beds for one year", async () => {
  const { property, beds } = await buildProperty("landlord-a", 2);
  const period = await buildPeriod();
  statements.length = 0;
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 180000 });

  assert.equal(listing.status, "DRAFT");
  assert.equal(listing.price, 180000);
  assert.equal(listing.spaceLabel, "Bed A", "the listing carries the labels the tables need");
  assert.equal(listing.propertyId, property.id);
  assert.equal(listing.periodName, period.name);

  const insert = statements.find((entry) => /INSERT INTO hostel_listings/.test(entry.sql));
  assert.equal(insert.args[3], "180000", "the rent is bound as pesewas");
  assert.equal(statements.filter((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql)).at(-1).args[2], "HOSTEL_LISTING_CREATED");

  const own = await listHostelListingsForProperty("landlord-a", property.id);
  assert.equal(own.length, 1);
});

test("a bed cannot be listed twice for the same year", async () => {
  const { beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 150000 });

  const before = statements.length;
  await assert.rejects(
    () => createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 160000 }),
    (error) => error?.code === "CONFLICT",
  );
  assert.deepEqual(statements.slice(before).filter((entry) => /INSERT INTO hostel_listings/.test(entry.sql)), [], "a refused listing writes nothing");
});

test("another landlord's bed and listing stay out of reach", async () => {
  const { property, beds } = await buildProperty("landlord-a", 2);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });

  await assert.rejects(
    () => createHostelListing("landlord-b", { spaceId: beds[0].id, periodId: period.id, price: 100000 }),
    (error) => error?.code === "NOT_FOUND",
    "a valid bed id is not a permission",
  );
  await assert.rejects(() => getHostelListing("landlord-b", listing.id), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(() => updateHostelListing("landlord-b", listing.id, { price: 100000 }), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(() => submitHostelListing("landlord-b", listing.id), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(() => removeHostelListing("landlord-b", listing.id), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(() => listHostelListingsForProperty("landlord-b", property.id), (error) => error?.code === "NOT_FOUND");

  const ownedRead = statements.filter((entry) => /FROM hostel_listings l/.test(entry.sql) && /p\.landlord_id = \?/.test(entry.sql)).at(-1);
  assert.ok(ownedRead.args.includes("landlord-b"), "the owner id is bound into the query, not filtered after");
});

test("a retired bed and a closed year cannot be listed", async () => {
  const { beds } = await buildProperty("landlord-a", 2);
  const open = await buildPeriod();
  const closed = await buildPeriod();
  await closeHostelPeriod("admin@umat.edu.gh", closed.id);
  spaces.find((item) => item.id === beds[1].id).status = "RETIRED";

  await assert.rejects(
    () => createHostelListing("landlord-a", { spaceId: beds[1].id, periodId: open.id, price: 120000 }),
    (error) => error?.code === "INVALID_STATE",
  );
  await assert.rejects(
    () => createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: closed.id, price: 120000 }),
    (error) => error?.code === "INVALID_STATE",
  );
});

test("submitting sends a draft to the queue exactly once", async () => {
  const { beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 175000 });

  const submitted = await submitHostelListing("landlord-a", listing.id);
  assert.equal(submitted.status, "PENDING_REVIEW");
  assert.ok(submitted.submittedAt, "the queue needs the time it was submitted");
  await assert.rejects(() => submitHostelListing("landlord-a", listing.id), (error) => error?.code === "INVALID_STATE");

  const record = listings.find((item) => item.id === listing.id);
  assert.equal(record.status, "PENDING_REVIEW");
  const audit = statements.filter((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql)).at(-1);
  assert.equal(audit.args[2], "HOSTEL_LISTING_SUBMITTED");
});

test("approving publishes the bed, accepts the building and records who decided", async () => {
  const { property, beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 220000 });
  await submitHostelListing("landlord-a", listing.id);

  const approved = await reviewHostelListing({ listingId: listing.id, action: "APPROVE", actor: "mod@umat.edu.gh" });
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.reviewReason, "");
  assert.equal(approved.reviewedBy, "mod@umat.edu.gh");
  assert.ok(approved.reviewedAt);
  assert.equal(properties.find((item) => item.id === property.id).status, "APPROVED", "a reviewer who approves a bed has seen the building");

  const actions = statements.filter((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql)).map((entry) => entry.args[2]);
  assert.ok(actions.includes("HOSTEL_LISTING_APPROVE"));
  assert.ok(actions.includes("HOSTEL_PROPERTY_APPROVED"));
});

test("a rejected listing comes back to the landlord as a draft with the reason", async () => {
  const { beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 210000 });
  await submitHostelListing("landlord-a", listing.id);

  await assert.rejects(
    () => reviewHostelListing({ listingId: listing.id, action: "REJECT", actor: "mod@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
    "a rejection without a reason tells the landlord nothing",
  );

  const rejected = await reviewHostelListing({ listingId: listing.id, action: "REJECT", reason: "The photo shows a different building.", actor: "mod@umat.edu.gh" });
  assert.equal(rejected.status, "DRAFT");
  assert.equal(rejected.reviewReason, "The photo shows a different building.");

  const resubmitted = await submitHostelListing("landlord-a", listing.id);
  assert.equal(resubmitted.status, "PENDING_REVIEW");
  assert.equal(resubmitted.reviewReason, "", "resubmitting clears the old reason");
});

test("repricing a live listing sends it back to review", async () => {
  const { beds } = await buildProperty("landlord-a", 2);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });
  const draft = await createHostelListing("landlord-a", { spaceId: beds[1].id, periodId: period.id, price: 150000 });
  await submitHostelListing("landlord-a", listing.id);
  await reviewHostelListing({ listingId: listing.id, action: "APPROVE", actor: "mod@umat.edu.gh" });

  const repriced = await updateHostelListing("landlord-a", listing.id, { price: 240000 });
  assert.equal(repriced.status, "DRAFT", "a cheaper or dearer bed is a different offer");
  assert.equal(repriced.price, 240000);

  const unchanged = await updateHostelListing("landlord-a", draft.id, { price: 155000 });
  assert.equal(unchanged.status, "DRAFT");

  await submitHostelListing("landlord-a", draft.id);
  await reviewHostelListing({ listingId: draft.id, action: "APPROVE", actor: "admin@umat.edu.gh" });
  await reviewHostelListing({ listingId: draft.id, action: "SUSPEND", reason: "Student complaint under investigation.", actor: "admin@umat.edu.gh" });
  await assert.rejects(() => updateHostelListing("landlord-a", draft.id, { price: 100000 }), (error) => error?.code === "INVALID_STATE", "a suspension is the platform's to lift");
  await assert.rejects(() => submitHostelListing("landlord-a", draft.id), (error) => error?.code === "INVALID_STATE");
});

test("a draft can be withdrawn, a live bed cannot", async () => {
  const { beds } = await buildProperty("landlord-a", 2);
  const period = await buildPeriod();
  const live = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });
  const draft = await createHostelListing("landlord-a", { spaceId: beds[1].id, periodId: period.id, price: 150000 });
  await submitHostelListing("landlord-a", live.id);
  await reviewHostelListing({ listingId: live.id, action: "APPROVE", actor: "mod@umat.edu.gh" });

  await assert.rejects(() => removeHostelListing("landlord-a", live.id), (error) => error?.code === "INVALID_STATE");
  assert.equal((await removeHostelListing("landlord-a", draft.id)).removed, true);
  assert.equal(listings.some((item) => item.id === draft.id), false, "a withdrawn listing is gone, so the bed can be priced again");
});

test("suspending hides a live bed for a stated reason", async () => {
  const { beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 195000 });
  await assert.rejects(
    () => reviewHostelListing({ listingId: listing.id, action: "SUSPEND", reason: "Any reason", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE",
    "there is nothing live to suspend yet",
  );
  await submitHostelListing("landlord-a", listing.id);
  await reviewHostelListing({ listingId: listing.id, action: "APPROVE", actor: "mod@umat.edu.gh" });
  await assert.rejects(
    () => reviewHostelListing({ listingId: listing.id, action: "SUSPEND", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
  );

  const suspended = await reviewHostelListing({ listingId: listing.id, action: "SUSPEND", reason: "Building condemned by the assembly.", actor: "admin@umat.edu.gh" });
  assert.equal(suspended.status, "SUSPENDED");
  assert.equal(suspended.reviewReason, "Building condemned by the assembly.");
});

test("only approved beds in live rooms are visible to students", async () => {
  const { property, beds } = await buildProperty("landlord-a", 3, { utilitiesEnabled: true });
  const period = await buildPeriod();
  const approved = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });
  const draft = await createHostelListing("landlord-a", { spaceId: beds[1].id, periodId: period.id, price: 150000 });
  const third = await createHostelListing("landlord-a", { spaceId: beds[2].id, periodId: period.id, price: 180000 });
  await submitHostelListing("landlord-a", approved.id);
  await submitHostelListing("landlord-a", third.id);
  await reviewHostelListing({ listingId: approved.id, action: "APPROVE", actor: "mod@umat.edu.gh" });
  await reviewHostelListing({ listingId: third.id, action: "APPROVE", actor: "mod@umat.edu.gh" });

  const first = await listPublicSpaces({ propertyId: property.id });
  assert.deepEqual(first.spaces.map((space) => space.spaceId).sort(), [beds[0].id, beds[2].id].sort(), "a draft bed is not public");
  const visible = first.spaces.find((space) => space.spaceId === beds[0].id);
  assert.equal(visible.price, 200000);
  assert.equal(visible.utilitiesFee, 2000, "the room's utilities fee rides along when the property charges one");
  assert.equal(visible.total, 202000);
  assert.equal(draft.id && first.spaces.some((space) => space.listingId === draft.id), false);

  spaces.find((item) => item.id === beds[2].id).status = "RETIRED";
  assert.deepEqual((await listPublicSpaces({ propertyId: property.id })).spaces.map((space) => space.spaceId), [beds[0].id], "a retired bed leaves the catalogue");

  await reviewHostelListing({ listingId: approved.id, action: "SUSPEND", reason: "Complaint upheld.", actor: "admin@umat.edu.gh" });
  assert.equal((await listPublicSpaces({ propertyId: property.id })).spaces.length, 0, "a suspended bed leaves the catalogue");

  properties.find((item) => item.id === property.id).status = "SUSPENDED";
  listings.find((item) => item.id === approved.id).status = "APPROVED";
  assert.equal((await listPublicSpaces({ propertyId: property.id })).spaces.length, 0, "a suspended building takes its beds with it");
});

test("a closed year closes the public catalogue too", async () => {
  const { property, beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });
  await submitHostelListing("landlord-a", listing.id);
  await reviewHostelListing({ listingId: listing.id, action: "APPROVE", actor: "mod@umat.edu.gh" });
  assert.equal((await listPublicSpaces({ propertyId: property.id })).spaces.length, 1);

  await closeHostelPeriod("admin@umat.edu.gh", period.id);
  const byDefault = await listPublicSpaces({ propertyId: property.id });
  assert.equal(byDefault.spaces.length, 0, "a closed year's beds leave the catalogue");
  assert.notEqual(byDefault.period?.id, period.id, "a closed year is never the year a visitor is quoted");
  const askedForTheClosedYear = await listPublicSpaces({ propertyId: property.id, periodId: period.id });
  assert.deepEqual(askedForTheClosedYear.spaces, [], "asking for a closed year by name returns nothing");
});

test("the staff queue shows what needs deciding and what is live", async () => {
  const { beds } = await buildProperty("landlord-a", 2);
  const period = await buildPeriod();
  const waiting = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });
  const live = await createHostelListing("landlord-a", { spaceId: beds[1].id, periodId: period.id, price: 150000 });
  await submitHostelListing("landlord-a", waiting.id);
  await submitHostelListing("landlord-a", live.id);
  await reviewHostelListing({ listingId: live.id, action: "APPROVE", actor: "mod@umat.edu.gh" });

  const queue = await listHostelListingsForStaff("PENDING_REVIEW");
  assert.ok(queue.some((item) => item.id === waiting.id));
  assert.equal(queue.some((item) => item.id === live.id), false, "an approved bed is not waiting on anyone");
  assert.equal(queue.find((item) => item.id === waiting.id).landlordPhone, "0551234567", "a reviewer can call the landlord");

  const approved = await listHostelListingsForStaff("APPROVED");
  assert.ok(approved.some((item) => item.id === live.id));
  assert.equal(approved.some((item) => item.id === waiting.id), false);
});

test("the review endpoint gives each move to the role that owns it", async () => {
  const { beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });
  const call = async (actor, action, reason) => {
    const response = await listingReviewRoute.PATCH(
      new Request(`${URL_BASE}/api/console/hostel/listings/${listing.id}/review`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: await cookieFor(actor) },
        body: JSON.stringify({ action, reason }),
      }),
      { params: Promise.resolve({ listingId: listing.id }) },
    );
    return { status: response.status, body: await response.json() };
  };

  const wrongRole = await call("acc-mod", "SUBMIT");
  assert.equal(wrongRole.status, 403, "a moderator does not act as a landlord");
  assert.equal(wrongRole.body.code, "FORBIDDEN");

  const landlordApprove = await call("acc-landlord", "APPROVE");
  assert.equal(landlordApprove.status, 403, "a landlord cannot approve their own bed");

  assert.equal((await call("acc-landlord", "SUBMIT")).status, 200);
  const moderatorSuspend = await call("acc-mod", "SUSPEND");
  assert.equal(moderatorSuspend.status, 403, "pulling a live bed belongs to an administrator");

  const moderatorApprove = await call("acc-mod", "APPROVE");
  assert.equal(moderatorApprove.status, 200);
  assert.equal(moderatorApprove.body.listing.status, "APPROVED");
  assert.equal(moderatorApprove.body.listing.reviewedBy, "mod@umat.edu.gh", "the decision names the signed-in account");
});

test("the public reads need no session and the console reads do", async () => {
  const { property, beds } = await buildProperty("landlord-a", 1);
  const period = await buildPeriod();
  const listing = await createHostelListing("landlord-a", { spaceId: beds[0].id, periodId: period.id, price: 200000 });

  const periodsResponse = await publicPeriodsRoute.GET();
  assert.equal(periodsResponse.status, 200);
  const periodsBody = await periodsResponse.json();
  assert.ok(periodsBody.periods.some((item) => item.id === period.id));
  assert.equal(periodsBody.periods[0].active, undefined, "the public shape is the contract's, not the console's");

  const spacesResponse = await publicSpacesRoute.GET(new Request(`https://umatexpress.example/api/hostel/spaces?propertyId=${property.id}`));
  assert.equal(spacesResponse.status, 200);
  assert.equal((await spacesResponse.json()).spaces.length, 0, "an unapproved bed is invisible");

  const signedOutQueue = await staffQueueRoute.GET(new Request(`${URL_BASE}/api/console/hostel/listings/review`));
  assert.equal(signedOutQueue.status, 401);
  const signedOutCreate = await listingsRoute.GET(new Request(`${URL_BASE}/api/console/hostel/listings?propertyId=${property.id}`));
  assert.equal(signedOutCreate.status, 401);
  const signedOutPeriods = await adminPeriodsRoute.GET(new Request(`${URL_BASE}/api/admin/hostel/periods`));
  assert.equal(signedOutPeriods.status, 401);

  const landlordRead = await listingsRoute.GET(new Request(`${URL_BASE}/api/console/hostel/listings?propertyId=${property.id}`, {
    headers: { cookie: await cookieFor("acc-landlord") },
  }));
  assert.equal(landlordRead.status, 200);
  assert.equal((await landlordRead.json()).listings.length, 1);

  const adminPeriods = await adminPeriodsRoute.GET(new Request(`${URL_BASE}/api/admin/hostel/periods`, {
    headers: { cookie: await cookieFor("acc-admin") },
  }));
  assert.equal(adminPeriods.status, 200);
  assert.ok((await adminPeriods.json()).periods.some((item) => item.id === period.id));

  const landlordPeriods = await adminPeriodsRoute.GET(new Request(`${URL_BASE}/api/admin/hostel/periods`, {
    headers: { cookie: await cookieFor("acc-landlord") },
  }));
  assert.equal(landlordPeriods.status, 403, "the catalogue is an administrator's to keep");

  void listing;
  void listingRoute;
});

test("the migration carries the review record both SQL files need", async () => {
  const foundation = await readFile(new URL("../sql/014_hostel_foundation.sql", import.meta.url), "utf8");
  const consolidated = await readFile(new URL("../sql/000_umatexpress_full_migration.sql", import.meta.url), "utf8");
  for (const column of ["submitted_at", "reviewed_at", "reviewed_by"]) {
    assert.match(foundation, new RegExp(`${column} TEXT NOT NULL DEFAULT ''`), `014 is missing ${column}`);
    assert.match(consolidated, new RegExp(`${column} TEXT NOT NULL DEFAULT ''`), `000 is missing ${column}`);
  }
  const index = /CREATE INDEX IF NOT EXISTS idx_hostel_listings_status_submitted ON hostel_listings\(status, submitted_at\)/;
  assert.match(foundation, index);
  assert.match(consolidated, index);
});
