import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://hostel-watchlist-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, plugins: [{ name: "test-hostel-schema", enforce: "pre", resolveId(source) { if (source === "@/lib/hostel-engine/landlord") return "\0test-hostel-schema"; }, load(id) { if (id === "\0test-hostel-schema") return "export async function ensureHostelTables() {}"; } }], server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
const { turso, rowsToObjects } = await vite.ssrLoadModule("/lib/turso.ts");
const watch = await vite.ssrLoadModule("/lib/hostel-engine/watchlist.ts");
await watch.ensureHostelWatchlist();
await turso("INSERT INTO hostel_periods (id,name,starts_on,ends_on,active,created_at) VALUES ('year','2026/27','2026-09-01','2027-07-31',1,'now')");
await turso("INSERT INTO hostel_properties (id,landlord_id,name,status,created_at,updated_at) VALUES ('a','landlord','Green Court','APPROVED','now','now'),('hidden','landlord','Hidden House','SUSPENDED','now','now')");
await turso("INSERT INTO hostel_rooms (id,property_id,label,capacity,status,created_at,updated_at) VALUES ('room-a','a','Room A',2,'ACTIVE','now','now'),('room-hidden','hidden','Room H',2,'ACTIVE','now','now')");
await turso("INSERT INTO hostel_spaces (id,room_id,status,created_at,updated_at) VALUES ('bed-a','room-a','AVAILABLE','now','now'),('bed-hidden','room-hidden','AVAILABLE','now','now')");
await turso("INSERT INTO hostel_listings (id,space_id,period_id,price,status,created_at,updated_at) VALUES ('listing-a','bed-a','year',100000,'APPROVED','now','now'),('listing-hidden','bed-hidden','year',100000,'APPROVED','now','now')");

const email = "student@example.com";
test("saved hostels belong to the student and reject unpublished properties", async () => {
  await watch.saveHostel(email, "a", "year");
  await assert.rejects(watch.saveHostel(email, "hidden", "year"), /no longer available/);
  assert.equal((await watch.listSavedHostels(email)).length, 1);
  assert.equal((await watch.listSavedHostels("other@example.com")).length, 0);
  await watch.saveHostel(email, "a", "year");
  assert.equal((await watch.listSavedHostels(email)).length, 1);
});

test("alert fires once when a saved hostel regains a bookable bed", async () => {
  await watch.setHostelAlert(email, "a", "year", true);
  assert.equal((await watch.scanHostelAvailability()).notified, 0);
  await turso("UPDATE hostel_spaces SET status='HELD' WHERE id='bed-a'");
  assert.equal((await watch.scanHostelAvailability()).notified, 0);
  assert.equal((await watch.listSavedHostels(email))[0].available, false);
  await turso("UPDATE hostel_spaces SET status='AVAILABLE' WHERE id='bed-a'");
  assert.equal((await watch.scanHostelAvailability()).notified, 1);
  assert.equal((await watch.scanHostelAvailability()).notified, 0);
  const outbox = rowsToObjects(await turso("SELECT recipient,template,reference FROM notification_outbox"));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].recipient, email);
  assert.equal(outbox[0].template, "hostel_bed_available");
  await watch.setHostelAlert(email, "a", "year", false);
  await turso("UPDATE hostel_spaces SET status='HELD' WHERE id='bed-a'");
  await watch.scanHostelAvailability();
  await turso("UPDATE hostel_spaces SET status='AVAILABLE' WHERE id='bed-a'");
  assert.equal((await watch.scanHostelAvailability()).notified, 0);
});

test("a saved property announces a newly approved academic year once", async () => {
  await watch.setHostelAlert(email, "a", "year", true);
  await turso("INSERT INTO hostel_periods (id,name,starts_on,ends_on,active,created_at) VALUES ('next','2027/28','2027-09-01','2028-07-31',1,'now')");
  assert.equal((await watch.scanHostelAvailability()).newYearNotified, 0);
  await turso("INSERT INTO hostel_listings (id,space_id,period_id,price,status,created_at,updated_at) VALUES ('listing-next','bed-a','next',110000,'APPROVED','now','now')");
  assert.equal((await watch.scanHostelAvailability()).newYearNotified, 1);
  assert.equal((await watch.scanHostelAvailability()).newYearNotified, 0);
  const notices = rowsToObjects(await turso("SELECT recipient,template,reference,message FROM notification_outbox WHERE template='hostel_year_open'"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].recipient, email);
  assert.match(String(notices[0].message), /periodId=next/);
});
