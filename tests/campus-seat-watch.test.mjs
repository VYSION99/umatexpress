import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * "Tell me when a seat opens."
 *
 * The quiet half of the day is when a student walks to a gate, finds nothing
 * live, and goes back to their room — and the platform never learns they wanted
 * a ride. A watch is that wish recorded against one route and settled later.
 * These tests hold the two promises that make it safe to offer: it is settled
 * exactly once, and it is only settled when a seat really is open.
 */

process.env.TURSO_DATABASE_URL = "https://campus-seat-watch-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const CAMPUS_SCHEMA_VERSION = "2026-09-23.2";
const WATCH_SCHEMA_VERSION = "2026-09-24.1";

const state = { watches: [], rides: [], notices: [] };

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
const okOne = () => ok({ cols: [], rows: [], affected_row_count: 1 });
const watchColumns = ["id", "corridor_id", "email", "name", "phone", "source", "active", "notified_at", "created_at", "updated_at"];

function openSlotsFor(corridorId) {
  return state.rides
    .filter((ride) => ride.corridor_id === corridorId && ride.status === "OPEN" && ride.accepting_queue === 1 && ride.available_slots > 0)
    .reduce((total, ride) => total + ride.available_slots, 0);
}

function handle(sql, args) {
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) {
    const version = /'campusSeatWatch'/.test(sql) ? WATCH_SCHEMA_VERSION : CAMPUS_SCHEMA_VERSION;
    return ok(table(["version"], [{ version }]));
  }
  if (/^INSERT INTO campus_seat_watch/.test(sql)) {
    const [id, corridorId, email, name, phone, source, createdAt, updatedAt] = args;
    const existing = state.watches.find((watch) => watch.corridor_id === corridorId && watch.email === email);
    if (existing) {
      Object.assign(existing, { name, phone, source, active: 1, notified_at: "", updated_at: updatedAt });
      return okOne();
    }
    state.watches.push({
      id, corridor_id: corridorId, email, name, phone, source, active: 1, notified_at: "",
      created_at: createdAt, updated_at: updatedAt,
    });
    return okOne();
  }
  if (/^SELECT \* FROM campus_seat_watch WHERE corridor_id = \? AND email = \? LIMIT 1/.test(sql)) {
    const watch = state.watches.find((item) => item.corridor_id === args[0] && item.email === args[1]);
    return ok(watch ? table(watchColumns, [watch]) : empty);
  }
  if (/^SELECT \* FROM campus_seat_watch WHERE corridor_id = \?/.test(sql)) {
    return ok(table(watchColumns, state.watches.filter((item) => item.corridor_id === args[0])));
  }
  if (/FROM campus_seat_watch w\s+LEFT JOIN campus_route_corridors c/.test(sql)) {
    const rows = state.watches
      .filter((watch) => watch.active === 1 && !watch.notified_at)
      .map((watch) => ({ watch_id: watch.id, corridor_id: watch.corridor_id, email: watch.email, name: watch.name, corridor_name: "Main Gate → Lecture Area", open_slots: openSlotsFor(watch.corridor_id), fare: 500 }))
      .filter((row) => row.open_slots > 0);
    return ok(table(["watch_id", "corridor_id", "email", "name", "corridor_name", "open_slots", "fare"], rows));
  }
  if (/^UPDATE campus_seat_watch SET notified_at = \?/.test(sql)) {
    const watch = state.watches.find((item) => item.id === args[2]);
    if (!watch || watch.notified_at) return ok({ cols: [], rows: [], affected_row_count: 0 });
    watch.notified_at = args[0];
    watch.updated_at = args[1];
    return okOne();
  }
  if (/^INSERT INTO notification_outbox/.test(sql)) {
    state.notices.push({ recipient: args[2], template: args[3], subject: args[4], message: args[5], reference: args[6] });
    return okOne();
  }
  return okOne();
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql.trim(), (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const watch = await vite.ssrLoadModule("/lib/campus-engine/watch.ts");
const notify = await vite.ssrLoadModule("/lib/campus-engine/notify-templates.ts");

test("a watch is recorded against one route and one address", async () => {
  const recorded = await watch.watchCampusCorridor({ corridorId: "gate-lecture", email: "  Ama@Student.UMaT.edu.gh ", name: "Ama" });
  assert.equal(recorded.corridorId, "gate-lecture");
  assert.equal(recorded.email, "ama@student.umat.edu.gh", "an address is normalised so two spellings are one person");
  assert.equal(recorded.active, true);
  assert.equal(recorded.notifiedAt, "");

  await assert.rejects(() => watch.watchCampusCorridor({ corridorId: "gate-lecture", email: "not-an-email" }), /usable/i);
  await assert.rejects(() => watch.watchCampusCorridor({ corridorId: "", email: "ama@student.umat.edu.gh" }), /route/i);
});

test("asking twice is one watch, not two emails", async () => {
  await watch.watchCampusCorridor({ corridorId: "hostel-campus", email: "kofi@student.umat.edu.gh", name: "Kofi" });
  await watch.watchCampusCorridor({ corridorId: "hostel-campus", email: "KOFI@student.umat.edu.gh", name: "Kofi Mensah" });
  const rows = await watch.listCampusSeatWatches({ corridorId: "hostel-campus" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Kofi Mensah", "the newest details win");
});

test("nothing is sent while the route has no seat, and one message when it does", async () => {
  const quiet = await watch.runCampusSeatWatchSweep();
  assert.equal(quiet.considered, 0, "a watch on a route with no ride is not even considered");
  assert.equal(state.notices.length, 0);

  state.rides.push({ corridor_id: "gate-lecture", status: "OPEN", accepting_queue: 1, available_slots: 2 });
  const first = await watch.runCampusSeatWatchSweep();
  assert.equal(first.considered, 1);
  assert.equal(first.notified, 1);
  assert.equal(state.notices.length, 1, "exactly one message per watch");
  assert.equal(state.notices[0].template, "campus_seats_open");
  assert.match(state.notices[0].message, /2 seats have opened/);
  assert.match(state.notices[0].message, /GH₵ 5\.00/);

  const second = await watch.runCampusSeatWatchSweep();
  assert.equal(second.considered, 0, "the promise is settled once and stays settled");
  assert.equal(state.notices.length, 1);
});

test("a full ride and a paused one are not seats", () => {
  const seats = watch.openSeatsByCorridor([
    { corridorId: "a", status: "OPEN", acceptingQueue: true, availableSlots: 3 },
    { corridorId: "a", status: "OPEN", acceptingQueue: true, availableSlots: 1 },
    { corridorId: "b", status: "FULL", acceptingQueue: true, availableSlots: 0 },
    { corridorId: "c", status: "PAUSED", acceptingQueue: false, availableSlots: 4 },
    { corridorId: "d", status: "OPEN", acceptingQueue: false, availableSlots: 2 },
  ]);
  assert.equal(seats.get("a"), 4);
  assert.equal(seats.has("b"), false);
  assert.equal(seats.has("c"), false, "a paused ride is not accepting riders");
  assert.equal(seats.has("d"), false, "a ride that stopped accepting is not a departure");
});

test("the message answers which run, how many, and what it costs", () => {
  const notice = notify.campusSeatWatchNotice({ corridorName: "Hostel Area → Main Campus", seatsOpen: 1, fare: 500 });
  assert.match(notice.message, /A seat has opened/);
  assert.match(notice.message, /Hostel Area → Main Campus/);
  assert.match(notice.message, /GH₵ 5\.00/);
  assert.match(notify.CAMPUS_NOTIFY_SUBJECTS.campus_seats_open, /seat/i);
});

test("re-watching a route re-arms it for the next seat", async () => {
  const settled = state.watches.find((item) => item.corridor_id === "gate-lecture");
  assert.ok(settled.notified_at, "the watch was settled by the sweep above");
  await watch.watchCampusCorridor({ corridorId: "gate-lecture", email: settled.email, name: "Ama" });
  assert.equal(settled.notified_at, "", "asking again is a new request for the next free seat");
  const again = await watch.runCampusSeatWatchSweep();
  assert.equal(again.considered, 1, "and it is settled again, once");
});

test("the endpoint asks for a route, and offers an address only when there is no account", async () => {
  const route = await vite.ssrLoadModule("/app/api/campus/watch/route.ts");
  const missing = await route.POST(new Request("http://localhost/api/campus/watch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ama@student.umat.edu.gh" }),
  }));
  assert.equal(missing.status, 400);

  const created = await route.POST(new Request("http://localhost/api/campus/watch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ corridorId: "campus-station", email: "yaa@student.umat.edu.gh", name: "Yaa" }),
  }));
  assert.equal(created.status, 200);
  const payload = await created.json();
  assert.equal(payload.watching, true);
  assert.equal(payload.watch.corridorId, "campus-station");

  const read = await route.GET(new Request("http://localhost/api/campus/watch?corridorId=campus-station&email=yaa@student.umat.edu.gh"));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).watching, true);

  const stranger = await route.GET(new Request("http://localhost/api/campus/watch?corridorId=campus-station&email=nobody@student.umat.edu.gh"));
  assert.equal((await stranger.json()).watching, false);
});
