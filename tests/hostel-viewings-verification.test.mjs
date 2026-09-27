import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-viewing-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const directory = mkdtempSync(join(tmpdir(), "hostel-viewing-"));
const database = join(directory, "db.sqlite");
const python = String.raw`
import sys,json,sqlite3
p=json.load(sys.stdin)
c=sqlite3.connect(sys.argv[1],isolation_level=None)
def go(s):
 a=[None if x['type']=='null' else int(x['value']) if x['type']=='integer' else x['value'] for x in s.get('args',[])]
 cur=c.execute(s['sql'],a)
 return {'cols':[{'name':x[0]} for x in cur.description or []],'rows':cur.fetchall(),'affected_row_count':max(0,cur.rowcount)}
r=[]
for q in p['requests']:
 if q['type']=='close': c.close();r.append({'type':'ok'});continue
 try:
  if q['type']=='execute': result=go(q['stmt'])
  else:
   values=[];errors=[]
   for x in q['batch']['steps']:
    try: values.append(go(x['stmt']));errors.append(None)
    except Exception as e: values.append(None);errors.append({'message':str(e)})
   result={'step_results':values,'step_errors':errors}
  r.append({'type':'ok','response':{'result':result}})
 except Exception as e:r.append({'type':'error','error':{'message':str(e)}})
print(json.dumps({'results':r}))`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  if (String(_url).startsWith("https://api.openrouteservice.org/")) {
    assert.equal(init.headers.Authorization, "route-test-key");
    return { ok: true, json: async () => ({ features: [{ properties: { summary: { distance: 1450, duration: 1080 } }, geometry: { coordinates: [[-2.00, 5.30], [-2.005, 5.305]] } }] }) };
  }
  const output = spawnSync("python3", ["-c", python, database], { input: init.body, encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  return { ok: true, json: async () => JSON.parse(output.stdout) };
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, plugins: [{ name: "hostel-test-stubs", enforce: "pre", resolveId(source) { if (source === "@/lib/hostel-engine/landlord" || source.endsWith("/lib/hostel-engine/landlord.ts")) return "\0landlord"; if (source === "@/lib/console-audit" || source.endsWith("/lib/console-audit.ts")) return "\0audit"; if (source === "@/lib/hostel-engine/photos" || source.endsWith("/lib/hostel-engine/photos.ts")) return "\0photos"; }, load(id) { if (id === "\0landlord") return "export async function ensureHostelTables() {}"; if (id === "\0audit") return "export async function consoleAudit() {}"; if (id === "\0photos") return "export async function ensureHostelPhotoTables() {}"; } }], server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });
const { turso } = await vite.ssrLoadModule("/lib/turso.ts");
const viewing = await vite.ssrLoadModule("/lib/hostel-engine/viewings.ts");
const verification = await vite.ssrLoadModule("/lib/hostel-engine/verification.ts");
const walking = await vite.ssrLoadModule("/lib/hostel-engine/walking.ts");
await viewing.ensureHostelViewingTables();
await turso("INSERT INTO hostel_properties (id,landlord_id,name,status,address,latitude,longitude,utilities_enabled,created_at,updated_at) VALUES ('p','landlord','Green Court','APPROVED','Main Road',5.30,-2.00,1,'first','first')");
await turso("INSERT INTO hostel_rooms (id,property_id,label,capacity,status,utilities_fee,created_at,updated_at) VALUES ('r','p','A1',2,'ACTIVE',100,'first','first')");
await turso("INSERT INTO hostel_spaces (id,room_id,label,status,created_at,updated_at) VALUES ('bed','r','A','AVAILABLE','first','first')");
await turso("INSERT INTO hostel_periods (id,name,starts_on,ends_on,active,created_at) VALUES ('year','2026/27','2026-09-01','2027-07-31',1,'first')");
await turso("INSERT INTO hostel_listings (id,space_id,period_id,price,status,created_at,updated_at) VALUES ('listing','bed','year',100000,'APPROVED','first','first')");

test("viewing slots enforce capacity and landlord ownership", async () => {
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 86_400_000 + 30 * 60_000).toISOString();
  await assert.rejects(() => viewing.createHostelViewingSlot({ landlordId: "other", propertyId: "p", startsAt, endsAt, capacity: 1, actor: "other" }), /not in your workspace/);
  const created = await viewing.createHostelViewingSlot({ landlordId: "landlord", propertyId: "p", startsAt, endsAt, capacity: 1, actor: "owner" });
  const slotId = created.slots[0].id;
  await assert.rejects(() => viewing.createHostelViewingSlot({ landlordId: "landlord", propertyId: "p", startsAt, endsAt, capacity: 1, actor: "owner" }), /already has a viewing/);
  await viewing.requestHostelViewing({ email: "one@example.com", propertyId: "p", slotId });
  await assert.rejects(() => viewing.requestHostelViewing({ email: "two@example.com", propertyId: "p", slotId }), /full, closed, or already requested/);
  const publicSlots = await viewing.listPublicViewingSlots("p", "one@example.com");
  assert.equal(publicSlots[0].myStatus, "PENDING");
  await assert.rejects(() => viewing.cancelStudentViewing("two@example.com", publicSlots[0].myRequestId), /not found/);
  await viewing.cancelStudentViewing("one@example.com", publicSlots[0].myRequestId);
  await viewing.requestHostelViewing({ email: "one@example.com", propertyId: "p", slotId });
  await assert.rejects(() => viewing.requestHostelViewing({ email: "two@example.com", propertyId: "p", slotId }), /full, closed, or already requested/);
  const again = await viewing.listPublicViewingSlots("p", "one@example.com");
  await viewing.cancelStudentViewing("one@example.com", again[0].myRequestId);
  await viewing.requestHostelViewing({ email: "two@example.com", propertyId: "p", slotId });
});

test("public verification needs a staff record and is invalidated by changed details", async () => {
  assert.deepEqual(await verification.listPublicHostelVerifications("p"), []);
  const record = await verification.recordHostelVerification({ propertyId: "p", kind: "LOCATION", action: "CHECK", note: "Inspected entrance and address on site.", actor: "staff@example.com" });
  assert.equal((await verification.listPublicHostelVerifications("p"))[0].id, record.id);
  await turso("UPDATE hostel_properties SET address='Changed Road',updated_at='second' WHERE id='p'");
  assert.deepEqual(await verification.listPublicHostelVerifications("p"), []);
  await verification.recordHostelVerification({ propertyId: "p", kind: "LOCATION", action: "CHECK", note: "Revisited entrance and changed address.", actor: "staff@example.com" });
  assert.equal((await verification.listPublicHostelVerifications("p")).length, 1);
  await verification.recordHostelVerification({ propertyId: "p", kind: "LOCATION", action: "REVOKE", note: "Location pin requires another visit.", actor: "staff@example.com" });
  assert.deepEqual(await verification.listPublicHostelVerifications("p"), []);
});


test("walking distance comes from the pedestrian route, separate from direct distance", async () => {
  process.env.OPENROUTESERVICE_API_KEY = "route-test-key";
  await turso("CREATE TABLE campus_zones (id TEXT PRIMARY KEY,name TEXT,latitude REAL,longitude REAL,active INTEGER)");
  await turso("INSERT INTO campus_zones VALUES ('library','Campus library',5.305,-2.005,1)");
  const route = await walking.getHostelWalkingRoute("p", "library");
  assert.equal(route.available, true);
  assert.equal(route.distanceM, 1450);
  assert.equal(route.durationMinutes, 18);
  assert.equal(route.coordinates.length, 2);
  delete process.env.OPENROUTESERVICE_API_KEY;
});
