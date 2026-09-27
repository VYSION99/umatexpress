import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-watchlist-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const directory = mkdtempSync(join(tmpdir(), "hostel-watchlist-"));
const database = join(directory, "test.sqlite");
const python = String.raw`
import sys, json, sqlite3
payload=json.load(sys.stdin)
connection=sqlite3.connect(sys.argv[1], isolation_level=None)
def execute(stmt):
    args=[None if a['type']=='null' else int(a['value']) if a['type']=='integer' else a['value'] for a in stmt.get('args',[])]
    cursor=connection.execute(stmt['sql'],args)
    rows=cursor.fetchall()
    return {'cols':[{'name':col[0]} for col in cursor.description or []], 'rows':rows, 'affected_row_count':max(0,cursor.rowcount)}
results=[]
for request in payload['requests']:
    if request['type']=='close':
        connection.close(); results.append({'type':'ok'}); continue
    try:
        if request['type']=='execute': result=execute(request['stmt'])
        else:
            values=[]; errors=[]
            for step in request['batch']['steps']:
                try: value=execute(step['stmt']); error=None
                except Exception as exc: value=None; error={'message':str(exc)}
                values.append(value); errors.append(error)
            result={'step_results':values,'step_errors':errors}
        results.append({'type':'ok','response':{'result':result}})
    except Exception as exc: results.append({'type':'error','error':{'message':str(exc)}})
print(json.dumps({'results':results}))
`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const output = spawnSync("python3", ["-c", python, database], { input: init.body, encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  return { ok: true, json: async () => JSON.parse(output.stdout) };
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, plugins: [{ name: "test-hostel-schema", enforce: "pre", resolveId(source) { if (source === "@/lib/hostel-engine/landlord") return "\0test-hostel-schema"; }, load(id) { if (id === "\0test-hostel-schema") return "export async function ensureHostelTables() {}"; } }], server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });
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
