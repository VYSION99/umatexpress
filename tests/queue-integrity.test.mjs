import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

// Adapts node:sqlite to the SqlExecutor shape the campusRide queue module uses.
// Responses mimic the Turso HTTP pipeline (rows as arrays of { value }).
function sqliteExecutor(db) {
  return async (sql, values = []) => {
    const statement = db.prepare(sql);
    const returnsRows = /^\s*(SELECT|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql);
    if (returnsRows) {
      const records = statement.all(...values);
      const names = records.length ? Object.keys(records[0]) : [];
      return {
        cols: names.map((name) => ({ name })),
        rows: records.map((record) => names.map((name) => ({ value: record[name] }))),
        affected_row_count: records.length,
      };
    }
    const info = statement.run(...values);
    return { affected_row_count: Number(info.changes || 0) };
  };
}

function newDatabase(capacity = 4) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE campus_rides (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'OPEN',
      accepting_queue INTEGER NOT NULL DEFAULT 1,
      capacity INTEGER NOT NULL,
      available_slots INTEGER NOT NULL,
      next_queue_position INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE campus_queue_entries (
      id TEXT PRIMARY KEY,
      ride_id TEXT NOT NULL,
      queue_position INTEGER NOT NULL,
      queue_status TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
      ticket_image_ready INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      accepted_at TEXT,
      arrived_at TEXT,
      boarded_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO campus_rides (id, capacity, available_slots, next_queue_position, updated_at) VALUES (?, ?, ?, 1, ?)")
    .run("ride-1", capacity, capacity, new Date().toISOString());
  return db;
}

async function loadQueue() {
  return vite.ssrLoadModule("/lib/campus-engine/queue.ts");
}

async function join(exec, queue, rideId, id, expiresAt = null) {
  const nowIso = new Date().toISOString();
  const claim = await queue.claimCampusQueueSlot(exec, { rideId, nowIso });
  if (!claim.ok) return claim;
  await exec(
    "INSERT INTO campus_queue_entries (id, ride_id, queue_position, queue_status, expires_at, updated_at) VALUES (?, ?, ?, 'WAITING_PAYMENT', ?, ?)",
    [id, rideId, claim.position, expiresAt, nowIso],
  );
  return claim;
}

function rideState(db, id = "ride-1") {
  // node:sqlite returns null-prototype rows; spread so strict deep-equal works.
  return { ...db.prepare("SELECT status, available_slots, next_queue_position FROM campus_rides WHERE id = ?").get(id) };
}

test("claims never exceed capacity and assign unique monotonic positions", async () => {
  const queue = await loadQueue();
  const db = newDatabase(4);
  const exec = sqliteExecutor(db);

  const positions = [];
  for (let index = 0; index < 6; index++) {
    const claim = await join(exec, queue, "ride-1", `entry-${index}`);
    if (claim.ok) positions.push(claim.position);
  }

  assert.deepEqual(positions, [1, 2, 3, 4]);
  assert.equal(new Set(positions).size, positions.length);
  assert.deepEqual(rideState(db), { status: "FULL", available_slots: 0, next_queue_position: 5 });
});

test("a cancelled position is never reused", async () => {
  const queue = await loadQueue();
  const db = newDatabase(2);
  const exec = sqliteExecutor(db);

  assert.deepEqual((await join(exec, queue, "ride-1", "a")).position, 1);
  assert.deepEqual((await join(exec, queue, "ride-1", "b")).position, 2);

  // Rider "a" is cancelled by the driver: status advances and its slot returns.
  db.prepare("UPDATE campus_queue_entries SET queue_status = 'PAID_WAITING' WHERE id = 'a'").run();
  const cancelled = await queue.applyCampusQueueTransition(exec, { entryId: "a", from: "PAID_WAITING", to: "CANCELLED_BY_DRIVER", timeColumn: "cancelled_at", nowIso: new Date().toISOString() });
  assert.equal(cancelled, true);
  await queue.releaseCampusSlots(exec, { rideId: "ride-1", count: 1, nowIso: new Date().toISOString() });

  // The freed slot is re-usable, but position 1 (and 2) are not handed out again.
  const next = await join(exec, queue, "ride-1", "c");
  assert.equal(next.ok, true);
  assert.equal(next.position, 3);
  assert.equal(rideState(db).available_slots, 0);
});

test("expired holds release exactly once", async () => {
  const queue = await loadQueue();
  const db = newDatabase(2);
  const exec = sqliteExecutor(db);
  const past = new Date(Date.now() - 60_000).toISOString();

  await join(exec, queue, "ride-1", "stale", past);
  assert.equal(rideState(db).available_slots, 1);

  const first = await queue.releaseExpiredCampusHolds(exec, { rideId: "ride-1", nowIso: new Date().toISOString() });
  assert.equal(first, 1);
  assert.equal(rideState(db).available_slots, 2);

  const second = await queue.releaseExpiredCampusHolds(exec, { rideId: "ride-1", nowIso: new Date().toISOString() });
  assert.equal(second, 0);
  assert.equal(rideState(db).available_slots, 2);
});

test("guarded transitions apply exactly once", async () => {
  const queue = await loadQueue();
  const db = newDatabase(1);
  const exec = sqliteExecutor(db);
  await join(exec, queue, "ride-1", "paid");

  const stamp = new Date().toISOString();
  const first = await queue.applyCampusQueueTransition(exec, { entryId: "paid", from: "WAITING_PAYMENT", to: "PAID_WAITING", paymentStatus: "SUCCESSFUL", ticketReady: true, nowIso: stamp });
  const second = await queue.applyCampusQueueTransition(exec, { entryId: "paid", from: "WAITING_PAYMENT", to: "PAID_WAITING", paymentStatus: "SUCCESSFUL", ticketReady: true, nowIso: stamp });

  assert.equal(first, true);
  assert.equal(second, false);
  const row = { ...db.prepare("SELECT queue_status, payment_status, ticket_image_ready FROM campus_queue_entries WHERE id = 'paid'").get() };
  assert.deepEqual(row, { queue_status: "PAID_WAITING", payment_status: "SUCCESSFUL", ticket_image_ready: 1 });
});

test("payment failure releases the held slot exactly once", async () => {
  const queue = await loadQueue();
  const db = newDatabase(1);
  const exec = sqliteExecutor(db);
  await join(exec, queue, "ride-1", "failed");
  assert.equal(rideState(db).available_slots, 0);

  const settle = async () => {
    const released = await queue.applyCampusQueueTransition(exec, { entryId: "failed", from: "WAITING_PAYMENT", to: "PAYMENT_FAILED", paymentStatus: "FAILED", nowIso: new Date().toISOString() });
    if (released) await queue.releaseCampusSlots(exec, { rideId: "ride-1", count: 1, nowIso: new Date().toISOString() });
    return released;
  };

  assert.equal(await settle(), true);
  assert.equal(rideState(db).available_slots, 1);
  assert.equal(await settle(), false);
  assert.equal(rideState(db).available_slots, 1);
});
