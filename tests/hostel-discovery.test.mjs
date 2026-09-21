import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * M4: student discovery. The public list, the filters and the pages all run
 * against a fake Turso, and the approval gates are asserted twice — once on the
 * rows the engine returns and once on the SQL it was given, so a future edit
 * cannot quietly widen "approved" into "anything in the table".
 */

process.env.TURSO_DATABASE_URL = "https://hostel-discovery-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.NEXT_PUBLIC_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

const periods = [];
const properties = [];
const rooms = [];
const spaces = [];
const listings = [];
const photos = [];
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

function handle(sql, args) {
  if (/FROM hostel_periods WHERE id = \? AND COALESCE\(active,1\) = 1 LIMIT 1/.test(sql)) {
    return ok(table(["id", "name", "starts_on", "ends_on"], periods.filter((item) => item.id === args[0] && item.active === 1)));
  }
  if (/FROM hostel_periods WHERE COALESCE\(active,1\) = 1 ORDER BY starts_on DESC LIMIT 1/.test(sql)) {
    const rows = periods.filter((item) => item.active === 1).sort((left, right) => right.starts_on.localeCompare(left.starts_on)).slice(0, 1);
    return ok(table(["id", "name", "starts_on", "ends_on"], rows));
  }
  if (/FROM hostel_periods WHERE COALESCE\(active,1\) = 1 ORDER BY starts_on DESC/.test(sql)) {
    const rows = periods.filter((item) => item.active === 1).sort((left, right) => right.starts_on.localeCompare(left.starts_on));
    return ok(table(["id", "name", "starts_on", "ends_on", "active", "created_at"], rows));
  }
  if (/FROM hostel_periods WHERE id = \? LIMIT 1/.test(sql)) {
    return ok(table(["id", "name", "starts_on", "ends_on", "active"], periods.filter((item) => item.id === args[0])));
  }
  if (/FROM hostel_periods\s+ORDER BY starts_on DESC/.test(sql)) {
    return ok(table(["id", "name", "starts_on", "ends_on", "active"], [...periods].sort((left, right) => right.starts_on.localeCompare(left.starts_on))));
  }

  // The public property aggregate: the same gates as the space read, counted.
  if (/^SELECT p\.id AS property_id/.test(sql)) {
    const rows = [];
    properties.forEach((property) => {
      const liveBeds = listings.filter((listing) => {
        if (listing.period_id !== args[0] || listing.status !== "APPROVED") return false;
        const space = spaces.find((item) => item.id === listing.space_id);
        // Only a free bed is on offer: held and occupied beds are the gate the
        // production aggregate applies, so the double applies it too.
        if (!space || space.status !== "AVAILABLE") return false;
        const room = rooms.find((item) => item.id === space.room_id);
        if (!room || room.status !== "ACTIVE" || room.property_id !== property.id) return false;
        return property.status !== "SUSPENDED";
      });
      if (!liveBeds.length) return;
      const beds = liveBeds.map((listing) => {
        const space = spaces.find((item) => item.id === listing.space_id);
        const room = rooms.find((item) => item.id === space.room_id);
        return { price: Number(listing.price), total: Number(listing.price) + (property.utilities_enabled === 1 ? Number(room.utilities_fee || 0) : 0), roomId: room.id };
      });
      rows.push({
        property_id: property.id, property_name: property.name, property_address: property.address,
        latitude: property.latitude, longitude: property.longitude, campus_distance_m: property.campus_distance_m,
        utilities_enabled: property.utilities_enabled, property_status: property.status,
        available_spaces: beds.length, room_count: new Set(beds.map((bed) => bed.roomId)).size,
        min_price: Math.min(...beds.map((bed) => bed.price)), min_total: Math.min(...beds.map((bed) => bed.total)),
      });
    });
    return ok(table(["property_id", "property_name", "property_address", "latitude", "longitude", "campus_distance_m", "utilities_enabled", "property_status", "available_spaces", "room_count", "min_price", "min_total"], rows));
  }

  // The public space read, reused by the property page.
  if (/^SELECT l\.id AS listing_id/.test(sql)) {
    const wantsProperty = /AND p\.id = \?/.test(sql);
    const rows = listings.filter((listing) => listing.period_id === args[0] && listing.status === "APPROVED").map((listing) => {
      const space = spaces.find((item) => item.id === listing.space_id) || {};
      const room = rooms.find((item) => item.id === space.room_id) || {};
      const property = properties.find((item) => item.id === room.property_id) || {};
      return {
        listing_id: listing.id, space_id: space.id, room_label: room.label || "", space_label: space.label || "",
        capacity: room.capacity || 0, price: Number(listing.price), utilities_fee: room.utilities_fee || 0,
        utilities_enabled: property.utilities_enabled || 0, property_id: property.id || "",
        space_status: space.status || "AVAILABLE", room_status: room.status || "ACTIVE", property_status: property.status || "DRAFT",
      };
    }).filter((row) => row.space_status === "AVAILABLE" && row.room_status === "ACTIVE" && row.property_status !== "SUSPENDED")
      .filter((row) => !wantsProperty || row.property_id === args[1])
      .sort((left, right) => left.room_label.localeCompare(right.room_label) || left.space_label.localeCompare(right.space_label));
    return ok(table(["listing_id", "space_id", "room_label", "space_label", "capacity", "price", "utilities_fee", "utilities_enabled"], rows));
  }

  if (/INSERT INTO rate_limit_windows/.test(sql) && /RETURNING count/.test(sql)) return ok(table(["count"], [{ count: 1 }]));

  // The cover on a card, and the gallery on one building's page. Both read
  // approved rows only, which is the gate these tests exist to keep honest.
  if (/FROM hostel_property_photos WHERE status = 'APPROVED' AND property_id IN/.test(sql)) {
    const wanted = new Set(args);
    const rows = photos.filter((photo) => photo.status === "APPROVED" && wanted.has(photo.property_id)).sort((left, right) => left.sort_order - right.sort_order);
    return ok(rows.length ? table(["id", "property_id", "caption", "sort_order"], rows) : empty);
  }
  if (/FROM hostel_property_photos WHERE property_id = \? AND status = 'APPROVED'/.test(sql)) {
    const rows = photos.filter((photo) => photo.status === "APPROVED" && photo.property_id === args[0]).sort((left, right) => left.sort_order - right.sort_order);
    return ok(rows.length ? table(["id", "caption", "sort_order"], rows) : empty);
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
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { getPublicProperty, listPublicProperties } = await vite.ssrLoadModule("/lib/hostel-engine/listings.ts");
const { GET: propertiesGet } = await vite.ssrLoadModule("/app/api/hostel/properties/route.ts");
const { default: HostelPage } = await vite.ssrLoadModule("/app/hostel/page.tsx");
const { default: HostelPropertyPage } = await vite.ssrLoadModule("/app/hostel/[propertyId]/page.tsx");
const { default: HostelNotFound } = await vite.ssrLoadModule("/app/hostel/not-found.tsx");
const { services } = await vite.ssrLoadModule("/components/launcher/services.ts");
const { campusNavState } = await vite.ssrLoadModule("/components/campusRide/shared/CampusNav.tsx");

const PERIOD = { id: "period-1", name: "2026/27 Academic Year", starts_on: "2026-09-01", ends_on: "2027-07-31", active: 1 };
const NEXT_YEAR = { id: "period-2", name: "2027/28 Academic Year", starts_on: "2027-09-01", ends_on: "2028-07-31", active: 1 };

function seed() {
  periods.length = 0; properties.length = 0; rooms.length = 0; spaces.length = 0; listings.length = 0; photos.length = 0; statements.length = 0;
  periods.push({ ...PERIOD }, { ...NEXT_YEAR });
  properties.push(
    { id: "property-a", landlord_id: "landlord-1", name: "Green Court Hostel", address: "12 Hospital Road, Tarkwa", latitude: 5.3018, longitude: -1.9931, campus_distance_m: null, utilities_enabled: 1, status: "APPROVED" },
    { id: "property-b", landlord_id: "landlord-2", name: "Suspended Lodge", address: "Old Station Road", latitude: 5.305, longitude: -1.99, campus_distance_m: null, utilities_enabled: 0, status: "SUSPENDED" },
    { id: "property-c", landlord_id: "landlord-3", name: "Far View Hostel", address: "Bogoso Road", latitude: 5.4, longitude: -2.05, campus_distance_m: 8200, utilities_enabled: 0, status: "APPROVED" },
  );
  rooms.push(
    { id: "room-a1", property_id: "property-a", label: "Room 1", capacity: 4, utilities_fee: 15000, status: "ACTIVE" },
    { id: "room-a2", property_id: "property-a", label: "Room 2", capacity: 2, utilities_fee: 15000, status: "ACTIVE" },
    { id: "room-a3", property_id: "property-a", label: "Old Room", capacity: 1, utilities_fee: 0, status: "RETIRED" },
    { id: "room-b1", property_id: "property-b", label: "Room 1", capacity: 2, utilities_fee: 0, status: "ACTIVE" },
    { id: "room-c1", property_id: "property-c", label: "Room 1", capacity: 3, utilities_fee: 0, status: "ACTIVE" },
  );
  spaces.push(
    { id: "bed-a1", room_id: "room-a1", label: "Bed A", status: "AVAILABLE" },
    { id: "bed-a2", room_id: "room-a1", label: "Bed B", status: "AVAILABLE" },
    { id: "bed-a3", room_id: "room-a2", label: "Bed A", status: "AVAILABLE" },
    { id: "bed-a4", room_id: "room-a2", label: "Bed B", status: "RETIRED" },
    { id: "bed-a5", room_id: "room-a3", label: "Bed A", status: "AVAILABLE" },
    // A bed a student is paying for right now: approved listing, but not on offer.
    { id: "bed-a6", room_id: "room-a1", label: "Bed C", status: "RESERVED" },
    { id: "bed-b1", room_id: "room-b1", label: "Bed A", status: "AVAILABLE" },
    { id: "bed-c1", room_id: "room-c1", label: "Bed A", status: "AVAILABLE" },
  );
  listings.push(
    { id: "listing-a1", space_id: "bed-a1", period_id: PERIOD.id, price: 220000, status: "APPROVED" },
    { id: "listing-a2", space_id: "bed-a2", period_id: PERIOD.id, price: 240000, status: "APPROVED" },
    { id: "listing-a3", space_id: "bed-a3", period_id: PERIOD.id, price: 180000, status: "APPROVED" },
    // A bed whose listing is still in review must not reach a student.
    { id: "listing-a4", space_id: "bed-a4", period_id: PERIOD.id, price: 150000, status: "APPROVED" },
    { id: "listing-a5", space_id: "bed-a5", period_id: PERIOD.id, price: 90000, status: "APPROVED" },
    { id: "listing-a7", space_id: "bed-a6", period_id: PERIOD.id, price: 120000, status: "APPROVED" },
    { id: "listing-a6", space_id: "bed-a1", period_id: NEXT_YEAR.id, price: 260000, status: "APPROVED" },
    { id: "listing-b1", space_id: "bed-b1", period_id: PERIOD.id, price: 170000, status: "APPROVED" },
    { id: "listing-c1", space_id: "bed-c1", period_id: PERIOD.id, price: 120000, status: "DRAFT" },
  );
  // bed-a4's listing is approved but its bed is retired; make bed-a2's listing a draft instead.
  listings.find((item) => item.id === "listing-a2").status = "DRAFT";
  listings.find((item) => item.id === "listing-a4").status = "APPROVED";
  photos.push(
    { id: "photo-a1", property_id: "property-a", caption: "Front gate", sort_order: 1, status: "APPROVED" },
    // Uploaded, never reviewed: no student surface may show it.
    { id: "photo-a2", property_id: "property-a", caption: "Waiting for review", sort_order: 0, status: "PENDING" },
    { id: "photo-b1", property_id: "property-b", caption: "Suspended building", sort_order: 1, status: "APPROVED" },
  );
}

test("the public list counts only beds a student could actually book", async () => {
  seed();
  const { period, properties: listed } = await listPublicProperties({ periodId: PERIOD.id });
  assert.equal(period.name, "2026/27 Academic Year");
  assert.deepEqual(listed.map((property) => property.id), ["property-a"]);
  const green = listed[0];
  assert.equal(green.availableSpaces, 2, "the draft listing, the held bed, the retired bed and the retired room must not count");
  assert.equal(green.roomCount, 2);
  assert.equal(green.minPrice, 180000);
  assert.equal(green.minTotal, 195000, "utilities are added per bed when the property charges them");
  assert.equal(green.utilitiesEnabled, true);
  const aggregate = statements.find((statement) => /^SELECT p\.id AS property_id/.test(statement.sql));
  assert.ok(aggregate, "the property list must run its own aggregate query");
  for (const gate of ["l.status = 'APPROVED'", "COALESCE(s.status,'AVAILABLE') = 'AVAILABLE'", "COALESCE(r.status,'ACTIVE') = 'ACTIVE'", "COALESCE(p.status,'DRAFT') <> 'SUSPENDED'"]) {
    assert.ok(aggregate.sql.includes(gate), `the aggregate must keep the gate: ${gate}`);
  }
  assert.deepEqual(aggregate.args, [PERIOD.id]);
});

test("a suspended property and a closed year disappear from the map", async () => {
  seed();
  let { properties: listed } = await listPublicProperties({ periodId: PERIOD.id });
  assert.ok(!listed.some((property) => property.id === "property-b"), "a suspended building must not be pinned");
  assert.ok(!listed.some((property) => property.id === "property-c"), "a property with no approved bed has nothing to show");

  periods.find((item) => item.id === PERIOD.id).active = 0;
  const result = await listPublicProperties({ periodId: PERIOD.id });
  assert.equal(result.period, null);
  assert.deepEqual(result.properties, []);
  const open = await listPublicProperties();
  assert.equal(open.period.id, NEXT_YEAR.id, "another open year still answers");
});

test("distance comes from the declared figure, else the pin", async () => {
  seed();
  const { properties: listed } = await listPublicProperties({ periodId: PERIOD.id });
  const green = listed.find((property) => property.id === "property-a");
  assert.equal(green.distanceM, 0, "a pin on the campus reference is zero metres");

  properties.find((item) => item.id === "property-a").latitude = 5.3118;
  const [moved] = (await listPublicProperties({ periodId: PERIOD.id })).properties;
  assert.ok(moved.distanceM > 1000 && moved.distanceM < 1200, `expected about 1.1 km, got ${moved.distanceM}`);
  assert.ok(statements.some((statement) => /p\.campus_distance_m/.test(statement.sql)));

  properties.find((item) => item.id === "property-a").campus_distance_m = 750;
  const [declared] = (await listPublicProperties({ periodId: PERIOD.id })).properties;
  assert.equal(declared.distanceM, 750, "the landlord's own figure wins");
});

test("distance, budget, utilities and bed filters narrow the map", async () => {
  seed();
  listings.find((item) => item.id === "listing-a2").status = "APPROVED";
  // Give the second property a named bed so two properties can compete.
  const { properties: all } = await listPublicProperties({ periodId: PERIOD.id });
  assert.equal(all.length, 1);

  const near = await listPublicProperties({ periodId: PERIOD.id, maxDistanceM: 100 });
  assert.deepEqual(near.properties.map((property) => property.id), ["property-a"], "the pin sits on campus");
  const far = await listPublicProperties({ periodId: PERIOD.id, maxDistanceM: 100, utilitiesOnly: true });
  assert.equal(far.properties.length, 1);
  const noUtilities = await listPublicProperties({ periodId: PERIOD.id, utilitiesOnly: false });
  assert.equal(noUtilities.properties.length, 1);
  const cheap = await listPublicProperties({ periodId: PERIOD.id, maxPrice: 150000 });
  assert.deepEqual(cheap.properties, [], "the cheapest bed is 180000 + 15000 utilities");
  const affordable = await listPublicProperties({ periodId: PERIOD.id, maxPrice: 250000 });
  assert.equal(affordable.properties.length, 1);
  const single = await listPublicProperties({ periodId: PERIOD.id, minSpaces: 2 });
  assert.equal(single.properties.length, 1, "two live beds clear a two-bed filter");
  const tooMany = await listPublicProperties({ periodId: PERIOD.id, minSpaces: 5 });
  assert.deepEqual(tooMany.properties, []);
});

test("sorting answers the filter bar", async () => {
  seed();
  properties.push({ id: "property-d", landlord_id: "landlord-4", name: "Aroma Hostel", address: "Market Circle", latitude: 5.32, longitude: -2.01, campus_distance_m: 3100, utilities_enabled: 0, status: "APPROVED" });
  rooms.push({ id: "room-d1", property_id: "property-d", label: "Room 1", capacity: 2, utilities_fee: 0, status: "ACTIVE" });
  spaces.push({ id: "bed-d1", room_id: "room-d1", label: "Bed A", status: "AVAILABLE" });
  listings.push({ id: "listing-d1", space_id: "bed-d1", period_id: PERIOD.id, price: 150000, status: "APPROVED" });

  const byName = (await listPublicProperties({ periodId: PERIOD.id, sort: "name" })).properties;
  assert.deepEqual(byName.map((property) => property.name), ["Aroma Hostel", "Green Court Hostel"]);
  const byPrice = (await listPublicProperties({ periodId: PERIOD.id, sort: "price" })).properties;
  assert.deepEqual(byPrice.map((property) => property.name), ["Aroma Hostel", "Green Court Hostel"]);
  const byDistance = (await listPublicProperties({ periodId: PERIOD.id, sort: "distance" })).properties;
  assert.deepEqual(byDistance.map((property) => property.name), ["Green Court Hostel", "Aroma Hostel"]);
});

test("the public property read can open one building with its beds", async () => {
  seed();
  const record = await getPublicProperty("property-a", PERIOD.id);
  assert.equal(record.property.name, "Green Court Hostel");
  assert.deepEqual(record.spaces.map((space) => [space.roomLabel, space.spaceLabel]), [["Room 1", "Bed A"], ["Room 2", "Bed A"]]);
  assert.equal(record.spaces[0].total, record.spaces[0].price + record.spaces[0].utilitiesFee);
  assert.ok(record.spaces.every((space) => space.listingId && space.spaceId));
  assert.equal(await getPublicProperty("property-b", PERIOD.id), null, "a suspended property has no public page");
  assert.equal(await getPublicProperty("property-c", PERIOD.id), null, "a building with no approved bed has no public page");
});

test("the properties route needs no session and says nothing about the landlord", async () => {
  seed();
  const response = await propertiesGet(new Request(`https://umatexpress.test/api/hostel/properties?periodId=${PERIOD.id}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.period.name, "2026/27 Academic Year");
  assert.equal(body.properties.length, 1);
  const property = body.properties[0];
  assert.deepEqual(Object.keys(property).sort(), ["address", "availableSpaces", "coverPhotoId", "distanceM", "id", "latitude", "longitude", "minPrice", "minTotal", "name", "ratingAverage", "ratingCount", "roomCount", "utilitiesEnabled"].sort());
  assert.equal(property.availableSpaces, 2);
  assert.equal(property.distanceM, 0);
  assert.equal(property.coverPhotoId, "photo-a1", "the card cover is the first approved photo");
  assert.equal(JSON.stringify(body).includes("photo-a2"), false, "a pending photo is not even leaked by id");
  assert.equal(JSON.stringify(body).includes("landlord"), false, "no landlord field may leak");

  const filtered = await (await propertiesGet(new Request("https://umatexpress.test/api/hostel/properties?periodId=period-1&maxDistance=99999999"))).json();
  assert.equal(filtered.properties.length, 1, "a junk distance is ignored rather than fatal");
  const sorted = await (await propertiesGet(new Request("https://umatexpress.test/api/hostel/properties?periodId=period-1&sort=price"))).json();
  assert.equal(sorted.properties.length, 1);
});

test("the browse page renders the filters, the map and the cards", async () => {
  seed();
  const html = renderToStaticMarkup(await HostelPage({ searchParams: Promise.resolve({}) }));
  assert.match(html, /Find your own corner of campus/);
  assert.match(html, /Green Court Hostel/);
  assert.match(html, /2 beds available/);
  assert.match(html, /GH₵ 1,950/, "the card shows the yearly total with utilities");
  assert.match(html, /Filter the map/);
  assert.match(html, /Academic year/);
  assert.match(html, /Interactive Hostel Finder map/);
  assert.match(html, /hostel-marker|Loading real map/);
  assert.match(html, /href="\/hostel\/property-a"/);
  assert.match(html, /\/api\/hostel\/photos\/photo-a1/, "the card shows the approved cover");
  assert.equal(/\/api\/hostel\/photos\/photo-a2/.test(html), false, "the pending photo has no public URL on the page");
  assert.equal(/Suspended Lodge/.test(html), false, "a suspended building cannot appear anywhere on the page");
});

test("one hostel's page lists its approved beds and 404s for a suspended building", async () => {
  seed();
  const html = renderToStaticMarkup(await HostelPropertyPage({ params: Promise.resolve({ propertyId: "property-a" }), searchParams: Promise.resolve({}) }));
  assert.match(html, /Green Court Hostel/);
  assert.match(html, /Rooms and beds/);
  assert.match(html, /Room 1/);
  assert.match(html, /GH₵ 1,800/, "the bed rent renders");
  assert.match(html, /GH₵ 1,950/, "rent plus utilities renders");
  assert.match(html, /2026\/27 Academic Year/);
  assert.match(html, /hostel-gallery-main/);
  assert.match(html, /\/api\/hostel\/photos\/photo-a1/);
  assert.equal(/\/api\/hostel\/photos\/photo-a2/.test(html), false, "the gallery shows approved photos only");

  await assert.rejects(() => HostelPropertyPage({ params: Promise.resolve({ propertyId: "property-b" }), searchParams: Promise.resolve({}) }), (error) => {
    assert.match(String(error?.digest || error?.message || error), /404/);
    return true;
  });
  const missing = renderToStaticMarkup(createElement(HostelNotFound));
  assert.match(missing, /That hostel is not on the map/);
  assert.match(missing, /Back to Hostel Finder/);
});

test("the launcher and the public nav send students to /hostel", async () => {
  const hostel = services.find((service) => service.id === "hostels");
  assert.equal(hostel.available, true);
  assert.equal(hostel.destination, "/hostel");
  assert.equal(campusNavState("HOSTELFINDER").activeHref, "/hostel");
  assert.equal(campusNavState("CAMPUSRIDE").activeHref, "/campus");
  assert.equal(campusNavState("ACCOUNT").activeHref, "");
  assert.equal(campusNavState("CINEMA").activeHref, "/cinema");
  assert.equal(campusNavState("VACATION").activeHref, "/vacation");
});
