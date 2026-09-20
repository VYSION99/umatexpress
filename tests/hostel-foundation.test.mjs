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
const rooms = [];
const spaces = [];
const listings = [];
const statements = [];

const ROOM_COLUMNS = ["id", "property_id", "label", "capacity", "utilities_fee", "amenities", "status", "created_at", "updated_at"];
const SPACE_COLUMNS = ["id", "room_id", "label", "status", "created_at", "updated_at"];

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
  if (/^SELECT id FROM hostel_rooms WHERE property_id = \? AND label = \? AND status = 'ACTIVE'( AND id <> \?)? LIMIT 1/.test(sql)) {
    const [propertyId, label, exceptId] = args;
    const row = rooms.find((item) => item.property_id === propertyId && item.label === label && item.status === "ACTIVE" && item.id !== exceptId);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/INSERT INTO hostel_rooms/.test(sql)) {
    const [id, propertyId, label, capacity, utilitiesFee, amenities, createdAt, updatedAt] = args;
    rooms.push({ id, property_id: propertyId, label, capacity: Number(capacity), utilities_fee: Number(utilitiesFee), amenities, status: "ACTIVE", created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_rooms SET label=\?,capacity=\?,utilities_fee=\?,amenities=\?,status=\?,updated_at=\? WHERE id=\? AND property_id=\?/.test(sql)) {
    const [label, capacity, utilitiesFee, amenities, status, updatedAt, id, propertyId] = args;
    const row = rooms.find((item) => item.id === id && item.property_id === propertyId);
    if (row) Object.assign(row, { label, capacity: Number(capacity), utilities_fee: Number(utilitiesFee), amenities, status, updated_at: updatedAt });
    return ok();
  }
  if (/^SELECT id FROM hostel_spaces WHERE room_id = \? AND label = \? AND status <> 'RETIRED' AND id <> \? LIMIT 1/.test(sql)) {
    const [roomId, label, exceptId] = args;
    const row = spaces.find((item) => item.room_id === roomId && item.label === label && item.status !== "RETIRED" && item.id !== exceptId);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/INSERT INTO hostel_spaces/.test(sql)) {
    const [id, roomId, label, createdAt, updatedAt] = args;
    spaces.push({ id, room_id: roomId, label, status: "AVAILABLE", created_at: createdAt, updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_spaces SET status='RETIRED',updated_at=\? WHERE id=\?/.test(sql)) {
    const [updatedAt, id] = args;
    const row = spaces.find((item) => item.id === id);
    if (row) Object.assign(row, { status: "RETIRED", updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_spaces SET status='RETIRED',updated_at=\? WHERE room_id=\?/.test(sql)) {
    const [updatedAt, roomId] = args;
    for (const row of spaces.filter((item) => item.room_id === roomId && item.status !== "RETIRED")) Object.assign(row, { status: "RETIRED", updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_spaces SET status='AVAILABLE',updated_at=\? WHERE id=\?/.test(sql)) {
    const [updatedAt, id] = args;
    const row = spaces.find((item) => item.id === id);
    if (row) Object.assign(row, { status: "AVAILABLE", updated_at: updatedAt });
    return ok();
  }
  if (/^UPDATE hostel_spaces SET label=\?,status=\?,updated_at=\? WHERE id=\?/.test(sql)) {
    const [label, status, updatedAt, id] = args;
    const row = spaces.find((item) => item.id === id);
    if (row) Object.assign(row, { label, status, updated_at: updatedAt });
    return ok();
  }
  if (/^SELECT DISTINCT l\.space_id AS space_id FROM hostel_listings/.test(sql)) {
    const rows = listings
      .filter((item) => ["DRAFT", "PENDING_REVIEW", "APPROVED"].includes(item.status))
      .filter((item) => spaces.find((space) => space.id === item.space_id && space.room_id === args[0]));
    return ok(rows.length ? table(["space_id"], rows) : empty);
  }
  if (/^SELECT s\.id,s\.room_id,s\.label.*FROM hostel_spaces s WHERE s\.room_id = \? ORDER BY/.test(sql)) {
    return ok(table(SPACE_COLUMNS, spaces.filter((item) => item.room_id === args[0])));
  }
  if (/^SELECT s\.id,s\.room_id,s\.label.*FROM hostel_spaces s JOIN hostel_rooms r ON r\.id = s\.room_id JOIN hostel_properties p/.test(sql)) {
    const space = spaces.find((item) => item.id === args[0]);
    const room = space && rooms.find((item) => item.id === space.room_id);
    const owned = room && properties.find((item) => item.id === room.property_id && item.landlord_id === args[1]);
    return ok(owned ? table(SPACE_COLUMNS, [space]) : empty);
  }
  if (/^SELECT s\.id,s\.room_id,s\.label.*FROM hostel_spaces s JOIN hostel_rooms r ON r\.id = s\.room_id WHERE r\.property_id = \? ORDER BY/.test(sql)) {
    const rows = spaces.filter((item) => rooms.find((room) => room.id === item.room_id && room.property_id === args[0]));
    return ok(table(SPACE_COLUMNS, rows));
  }
  if (/^SELECT r\.id,r\.property_id,r\.label/.test(sql)) {
    const room = rooms.find((item) => item.id === args[0]);
    const owned = room && properties.find((item) => item.id === room.property_id && item.landlord_id === args[1]);
    return ok(owned ? table(ROOM_COLUMNS, [room]) : empty);
  }
  if (/^SELECT id,property_id,label,capacity/.test(sql)) {
    return ok(table(ROOM_COLUMNS, rooms.filter((item) => item.property_id === args[0])));
  }
  if (/^UPDATE hostel_properties SET name=\?,address=\?,latitude=\?,longitude=\?,utilities_enabled=\?,updated_at=\? WHERE id=\? AND landlord_id=\?/.test(sql)) {
    const [name, address, latitude, longitude, utilitiesEnabled, updatedAt, id, landlordId] = args;
    const row = properties.find((item) => item.id === id && item.landlord_id === landlordId);
    if (row) Object.assign(row, { name, address, latitude: latitude === null ? null : Number(latitude), longitude: longitude === null ? null : Number(longitude), utilities_enabled: utilitiesEnabled, updated_at: updatedAt });
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
const { createHostelProperty, createHostelRoom, getHostelProperty, getHostelRoom, listHostelProperties, registerLandlord, updateHostelProperty, updateHostelRoom, updateHostelSpace } = await vite.ssrLoadModule("/lib/hostel-engine/landlord.ts");
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

test("a room of N beds lands with N bookable bed-spaces", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Bed Space Villa", address: "Tarkwa main road" });
  const before = statements.length;
  const room = await createHostelRoom("landlord-a", property.id, {
    label: "Room 1", capacity: 3, utilitiesFee: 2500, amenities: "AC, wardrobe",
  });

  assert.equal(room.label, "Room 1");
  assert.equal(room.capacity, 3);
  assert.equal(room.utilitiesFee, 2500);
  assert.deepEqual(room.spaces.map((space) => space.label), ["Bed A", "Bed B", "Bed C"]);
  assert.deepEqual(room.spaces.map((space) => space.status), ["AVAILABLE", "AVAILABLE", "AVAILABLE"]);

  const written = statements.slice(before);
  const roomInsert = written.find((entry) => /INSERT INTO hostel_rooms/.test(entry.sql));
  assert.equal(roomInsert.args[3], "3", "capacity is bound into the room insert");
  assert.equal(written.filter((entry) => /INSERT INTO hostel_spaces/.test(entry.sql)).length, 3, "each bed is its own row a student can book");
  const audit = written.filter((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql)).at(-1);
  assert.equal(audit.args[2], "HOSTEL_ROOM_CREATED");
});

test("two live rooms on one property cannot share a name", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Rose Villa", address: "Tarkwa" });
  await createHostelRoom("landlord-a", property.id, { label: "Room 1", capacity: 2 });

  const before = statements.length;
  await assert.rejects(
    () => createHostelRoom("landlord-a", property.id, { label: "Room 1", capacity: 2 }),
    (error) => error?.code === "CONFLICT",
  );
  assert.deepEqual(statements.slice(before).filter((entry) => /INSERT INTO hostel_rooms/.test(entry.sql)), [], "a refused room writes nothing");

  const other = await createHostelProperty("landlord-a", { name: "Rose Villa Annexe", address: "Tarkwa" });
  const allowed = await createHostelRoom("landlord-a", other.id, { label: "Room 1", capacity: 2 });
  assert.equal(allowed.label, "Room 1", "the name is free on a different property");
});

test("a room, its beds and the property behind them stay out of another landlord's reach", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Palm Court", address: "Tarkwa" });
  const room = await createHostelRoom("landlord-a", property.id, { label: "Room 4", capacity: 2 });
  const bed = room.spaces[0];

  await assert.rejects(() => getHostelRoom("landlord-b", room.id), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(() => updateHostelRoom("landlord-b", room.id, { label: "Hijacked" }), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(() => updateHostelSpace("landlord-b", bed.id, { label: "Hijacked" }), (error) => error?.code === "NOT_FOUND");
  await assert.rejects(
    () => updateHostelProperty("landlord-b", property.id, { name: "Hijacked", address: "Somewhere else" }),
    (error) => error?.code === "NOT_FOUND",
  );

  const roomRead = statements.filter((entry) => /FROM hostel_rooms r JOIN hostel_properties p/.test(entry.sql)).at(-1);
  assert.deepEqual(roomRead.args, [room.id, "landlord-b"], "the owner id is bound into the query, not filtered after");
  const bedRead = statements.filter((entry) => /JOIN hostel_properties p ON p\.id = r\.property_id WHERE s\.id = \? AND p\.landlord_id = \?/.test(entry.sql)).at(-1);
  assert.deepEqual(bedRead.args, [bed.id, "landlord-b"], "a valid bed id is not a permission either");
});

test("shrinking a room retires its highest beds and growing brings them back", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Cedar Lodge", address: "Tarkwa" });
  const room = await createHostelRoom("landlord-a", property.id, { label: "Room 7", capacity: 3 });
  const topBed = room.spaces[2];

  const shrunk = await updateHostelRoom("landlord-a", room.id, { capacity: 2 });
  assert.deepEqual(shrunk.spaces.map((space) => `${space.label}:${space.status}`), ["Bed A:AVAILABLE", "Bed B:AVAILABLE", "Bed C:RETIRED"]);
  const retired = statements.filter((entry) => /^UPDATE hostel_spaces SET status='RETIRED',updated_at=\? WHERE id=\?/.test(entry.sql)).at(-1);
  assert.equal(retired.args[1], topBed.id, "the highest bed is the one that goes");

  const grown = await updateHostelRoom("landlord-a", room.id, { capacity: 3 });
  assert.equal(grown.spaces.length, 3, "growing back restores the bed instead of minting a second Bed C");
  assert.deepEqual(grown.spaces.map((space) => `${space.label}:${space.status}`), ["Bed A:AVAILABLE", "Bed B:AVAILABLE", "Bed C:AVAILABLE"]);
  assert.ok(statements.some((entry) => /^UPDATE hostel_spaces SET status='AVAILABLE',updated_at=\? WHERE id=\?/.test(entry.sql)));
});

test("a room holding a live listing will not shrink past that bed or retire", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Birch House", address: "Tarkwa" });
  const room = await createHostelRoom("landlord-a", property.id, { label: "Room 9", capacity: 3 });
  const listedBed = room.spaces[2];
  listings.push({ id: "listing-1", space_id: listedBed.id, period_id: "period-1", price: 45000, status: "PENDING_REVIEW" });

  await assert.rejects(
    () => updateHostelRoom("landlord-a", room.id, { capacity: 2 }),
    (error) => error?.code === "INVALID_STATE" && /Bed C/.test(error.message),
    "the refusal must name the bed a student is already looking at",
  );
  await assert.rejects(
    () => updateHostelRoom("landlord-a", room.id, { status: "RETIRED" }),
    (error) => error?.code === "INVALID_STATE",
  );
  assert.equal((await getHostelRoom("landlord-a", room.id)).status, "ACTIVE", "a refused retire leaves the room live");
  assert.equal(spaces.find((item) => item.id === listedBed.id).status, "AVAILABLE", "a refused shrink never retires the bed");

  listings.at(-1).status = "CANCELLED";
  const shrunk = await updateHostelRoom("landlord-a", room.id, { capacity: 2 });
  assert.deepEqual(shrunk.spaces.map((space) => space.status), ["AVAILABLE", "AVAILABLE", "RETIRED"], "a cancelled listing frees the bed");
});

test("a bed can be renamed, retired and restored, but no two live beds share a name", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Willow Court", address: "Tarkwa" });
  const room = await createHostelRoom("landlord-a", property.id, { label: "Room 2", capacity: 2 });
  const [first, second] = room.spaces;

  const renamed = await updateHostelSpace("landlord-a", first.id, { label: "Top bunk" });
  assert.equal(renamed.label, "Top bunk");
  const renameWrite = statements.filter((entry) => /^UPDATE hostel_spaces SET label=\?,status=\?,updated_at=\?/.test(entry.sql)).at(-1);
  assert.deepEqual(renameWrite.args.slice(0, 2), ["Top bunk", "AVAILABLE"]);

  const before = statements.length;
  await assert.rejects(
    () => updateHostelSpace("landlord-a", second.id, { label: "Top bunk" }),
    (error) => error?.code === "CONFLICT",
  );
  assert.deepEqual(statements.slice(before).filter((entry) => /^UPDATE hostel_spaces SET label=/.test(entry.sql)), [], "a refused rename writes nothing");

  assert.equal((await updateHostelSpace("landlord-a", second.id, { status: "RETIRED" })).status, "RETIRED");
  assert.equal((await updateHostelSpace("landlord-a", second.id, { status: "AVAILABLE" })).status, "AVAILABLE");
});

test("room and bed validation happens before anything is written", async () => {
  const property = await createHostelProperty("landlord-a", { name: "Aspen Flats", address: "Tarkwa" });
  const room = await createHostelRoom("landlord-a", property.id, { label: "Room 5", capacity: 2 });

  const before = statements.length;
  await assert.rejects(() => createHostelRoom("landlord-a", property.id, { label: "Room 6", capacity: 9 }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => createHostelRoom("landlord-a", property.id, { label: "Room 6", capacity: 2, utilitiesFee: 9999999 }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => updateHostelSpace("landlord-a", room.spaces[0].id, { status: "BOOKED" }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => updateHostelRoom("landlord-a", room.id, { status: "LIVE" }), (error) => error?.code === "VALIDATION_ERROR");

  const writes = statements.slice(before).filter((entry) => /^(INSERT|UPDATE)/.test(entry.sql));
  assert.deepEqual(writes, [], "invalid input must never reach a write");
});

test("the hostel schema ships in both migration files", async () => {
  const foundation = await readFile(new URL("../sql/014_hostel_foundation.sql", import.meta.url), "utf8");
  const consolidated = await readFile(new URL("../sql/000_umatexpress_full_migration.sql", import.meta.url), "utf8");
  const tables = [...foundation.matchAll(/CREATE TABLE IF NOT EXISTS (hostel_\w+)/g)].map((match) => match[1]);
  assert.equal(tables.length, 7, "phase 1 ships seven hostel tables");
  for (const table of tables) assert.ok(consolidated.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `000 is missing ${table}`);
  assert.match(foundation, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_listings_space_period ON hostel_listings\(space_id, period_id\)/);
  const partialIndexes = [
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_rooms_property_label ON hostel_rooms\(property_id, label\) WHERE status = 'ACTIVE'/,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_spaces_room_label ON hostel_spaces\(room_id, label\) WHERE status <> 'RETIRED'/,
  ];
  for (const index of partialIndexes) {
    assert.match(foundation, index, "the room and bed labels must stay unique among live rows");
    assert.match(consolidated, index, "000 carries the same guard");
  }
  assert.match(foundation, /CHECK \(capacity BETWEEN 1 AND 6\)/);
  assert.ok(!/password_hash/.test(foundation), "credentials live in console_accounts, not the landlord row");
});
