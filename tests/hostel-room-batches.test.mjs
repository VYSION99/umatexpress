import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
process.env.TURSO_DATABASE_URL = "https://hostel-room-batches-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const directory = mkdtempSync(join(tmpdir(), "hostel-room-batches-"));
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
    if x['stmt']['sql']=='ROLLBACK':
     if any(errors):
      try: values.append(go(x['stmt']));errors.append(None)
      except Exception as e: values.append(None);errors.append({'message':str(e)})
     else: values.append(None);errors.append(None)
     continue
    if any(errors): values.append(None);errors.append(None);continue
    try: values.append(go(x['stmt']));errors.append(None)
    except Exception as e: values.append(None);errors.append({'message':str(e)})
   result={'step_results':values,'step_errors':errors}
  r.append({'type':'ok','response':{'result':result}})
 except Exception as e:r.append({'type':'error','error':{'message':str(e)}})
print(json.dumps({'results':r}))`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const output = spawnSync("python3", ["-c", python, database], { input: init.body, encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  return { ok: true, json: async () => JSON.parse(output.stdout) };
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, plugins: [{ name: "batch-stubs", enforce: "pre", resolveId(source) {
  if (source === "@/lib/hostel-engine/landlord" || source.endsWith("/lib/hostel-engine/landlord") || source.endsWith("/lib/hostel-engine/landlord.ts")) return "\0landlord";
  if (source === "@/lib/hostel-engine/onboarding" || source.endsWith("/lib/hostel-engine/onboarding") || source.endsWith("/lib/hostel-engine/onboarding.ts")) return "\0onboarding";
  if (source === "@/lib/console-audit" || source.endsWith("/lib/console-audit") || source.endsWith("/lib/console-audit.ts")) return "\0audit";
}, load(id) {
  if (id === "\0landlord") return `import { CampusEngineError } from '@/lib/campus-engine/errors'; export const HOSTEL_DEFAULT_COMMISSION_BPS=300; export async function ensureHostelTables() {} export async function getHostelProperty(owner,id) { if ((owner === 'owner' && id === 'p') || (owner === 'unverified' && id === 'other')) return { id, status: owner === 'owner' ? 'APPROVED' : 'DRAFT' }; throw new CampusEngineError('NOT_FOUND','Property not found.',404); }`;
  if (id === "\0onboarding") return "export async function ownerReadiness(owner) { return { identityStatus: owner === 'owner' ? 'VERIFIED' : 'PENDING', profileStatus: owner === 'owner' ? 'APPROVED' : 'PENDING' }; }";
  if (id === "\0audit") return "export async function consoleAudit() {}";
} }], server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); for (const [key,value] of Object.entries(saved)) { const name = key === "url" ? "TURSO_DATABASE_URL" : "TURSO_AUTH_TOKEN"; if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
const { turso, rowsToObjects } = await vite.ssrLoadModule("/lib/turso.ts");
const { createHostelRoomBatch, priceHostelRoomRange, submitHostelRoomRange } = await vite.ssrLoadModule("/lib/hostel-engine/room-batches.ts");
await turso("CREATE TABLE hostel_landlords (id TEXT PRIMARY KEY,commission_bps INTEGER DEFAULT 300)");
await turso("CREATE TABLE hostel_properties (id TEXT PRIMARY KEY,landlord_id TEXT,status TEXT,updated_at TEXT)");
await turso("CREATE TABLE hostel_rooms (id TEXT PRIMARY KEY,property_id TEXT,label TEXT,capacity INTEGER,utilities_fee INTEGER,amenities TEXT,bed_layout TEXT,status TEXT,created_at TEXT,updated_at TEXT)");
await turso("CREATE UNIQUE INDEX idx_rooms_label ON hostel_rooms(property_id,label) WHERE status='ACTIVE'");
await turso("CREATE TABLE hostel_spaces (id TEXT PRIMARY KEY,room_id TEXT,label TEXT,status TEXT,created_at TEXT,updated_at TEXT)");
await turso("CREATE TABLE hostel_periods (id TEXT PRIMARY KEY,name TEXT,active INTEGER,starts_on TEXT,ends_on TEXT)");
await turso("CREATE TABLE hostel_listings (id TEXT PRIMARY KEY,space_id TEXT,period_id TEXT,price INTEGER,status TEXT,review_reason TEXT,submitted_at TEXT,reviewed_at TEXT,reviewed_by TEXT,created_at TEXT,updated_at TEXT)");
await turso("INSERT INTO hostel_properties VALUES ('p','owner','DRAFT','now'),('other','unverified','DRAFT','now')");
await turso("INSERT INTO hostel_periods VALUES ('year','2026/27',1,'2026-09-01','2027-07-31'),('closed','2025/26',0,'2025-09-01','2026-07-31')");
const rows = async (sql, args = []) => rowsToObjects(await turso(sql, args));
const input = { propertyId: "p", prefix: "Room", start: 1, end: 20, width: 3, capacity: 4, bedLayout: "BUNK", utilitiesFee: 10000, amenities: "Desk, wardrobe", periodId: "year", price: 120000 };

test("twenty numbered bunk rooms and eighty separately priced beds are created atomically", async () => {
  const result = await createHostelRoomBatch("owner", input);
  assert.equal(result.created, 20);
  assert.equal(result.skipped, 0);
  const rooms = await rows("SELECT label,capacity,bed_layout,amenities FROM hostel_rooms ORDER BY label");
  assert.equal(rooms.length, 20);
  assert.equal(rooms[0].label, "Room 001"); assert.equal(rooms.at(-1).label, "Room 020");
  assert.ok(rooms.every(room => Number(room.capacity) === 4 && room.bed_layout === "BUNK" && room.amenities === "Desk, wardrobe"));
  const spaces = await rows("SELECT label FROM hostel_spaces");
  assert.equal(spaces.length, 80);
  assert.equal(spaces.filter(space => space.label === "Bunk 1 lower").length, 20);
  assert.equal(spaces.filter(space => space.label === "Bunk 1 upper").length, 20);
  const listings = await rows("SELECT price,status FROM hostel_listings");
  assert.equal(listings.length, 80);
  assert.ok(listings.every(row => Number(row.price) === 120000 && row.status === "DRAFT"));
});

test("a retry skips matching rooms and creates only the rest of a partly finished range", async () => {
  const retry = await createHostelRoomBatch("owner", input);
  assert.deepEqual([retry.created, retry.skipped], [0,20]);
  const rest = await createHostelRoomBatch("owner", { ...input, start: 15, end: 25 });
  assert.deepEqual([rest.created, rest.skipped], [5,6]);
  assert.equal((await rows("SELECT id FROM hostel_rooms")).length, 25);
  assert.equal((await rows("SELECT id FROM hostel_listings")).length, 100);
});

test("conflicts, oversized requests and other owners never create partial rooms", async () => {
  const before = (await rows("SELECT id FROM hostel_rooms")).length;
  await assert.rejects(() => createHostelRoomBatch("owner", { ...input, start: 1, end: 1, amenities: "Different" }), error => error.code === "CONFLICT");
  await assert.rejects(() => createHostelRoomBatch("owner", { ...input, start: 30, end: 50 }), error => error.code === "VALIDATION_ERROR");
  await assert.rejects(() => createHostelRoomBatch("stranger", { ...input, start: 30, end: 31 }), error => error.code === "NOT_FOUND");
  await assert.rejects(() => createHostelRoomBatch("owner", { ...input, start: 30, end: 31, periodId: "closed" }), error => error.code === "INVALID_STATE");
  assert.equal((await rows("SELECT id FROM hostel_rooms")).length, before);
});

test("unverified owners may prepare rooms but cannot set yearly bed rents", async () => {
  await assert.rejects(() => createHostelRoomBatch("unverified", { ...input, propertyId: "other", start: 1, end: 2 }), error => error.code === "INVALID_STATE");
  const prepared = await createHostelRoomBatch("unverified", { ...input, propertyId: "other", start: 1, end: 2, periodId: "", price: "" });
  assert.equal(prepared.created, 2);
  assert.equal((await rows("SELECT id FROM hostel_listings")).length, 100);
});


test("one operation reprices an existing range and skips matching beds on retry", async () => {
  const result = await priceHostelRoomRange("owner", { propertyId: "p", prefix: "Room", start: 1, end: 20, width: 3, periodId: "year", price: 130000 });
  assert.deepEqual([result.rooms, result.changed], [20,80]);
  const listingRows = await rows("SELECT price,status FROM hostel_listings");
  assert.equal(listingRows.filter(row => Number(row.price) === 130000).length, 80);
  assert.ok(listingRows.every(row => row.status === "DRAFT"));
  const retry = await priceHostelRoomRange("owner", { propertyId: "p", prefix: "Room", start: 1, end: 20, width: 3, periodId: "year", price: 130000 });
  assert.equal(retry.changed, 0);
});

test("pricing a range creates draft listings for rooms prepared earlier", async () => {
  await createHostelRoomBatch("owner", { ...input, start: 30, end: 31, periodId: "", price: "" });
  const priced = await priceHostelRoomRange("owner", { propertyId: "p", prefix: "Room", start: 30, end: 31, width: 3, periodId: "year", price: 150000 });
  assert.equal(priced.changed, 8);
  assert.equal((await rows("SELECT id FROM hostel_listings WHERE price=150000")).length, 8);
});

test("one blocked bed stops the entire rate batch before any writes", async () => {
  const room = (await rows("SELECT id FROM hostel_rooms WHERE label='Room 001'"))[0];
  const space = (await rows("SELECT id FROM hostel_spaces WHERE room_id=? LIMIT 1", [String(room.id)]))[0];
  await turso("UPDATE hostel_spaces SET status='OCCUPIED' WHERE id=?", [String(space.id)]);
  await assert.rejects(() => priceHostelRoomRange("owner", { propertyId: "p", prefix: "Room", start: 1, end: 20, width: 3, periodId: "year", price: 140000 }), error => error.code === "INVALID_STATE");
  assert.equal((await rows("SELECT id FROM hostel_listings WHERE price=140000")).length, 0);
  await turso("UPDATE hostel_spaces SET status='AVAILABLE' WHERE id=?", [String(space.id)]);
  await assert.rejects(() => priceHostelRoomRange("owner", { propertyId: "p", prefix: "Room", start: 1, end: 21, width: 3, periodId: "year", price: 140000 }), error => error.code === "VALIDATION_ERROR");
});

test("priced draft beds submit as one range and a retry skips beds already under review", async () => {
  const selected = { propertyId: "p", prefix: "Room", start: 1, end: 20, width: 3, periodId: "year" };
  const result = await submitHostelRoomRange("owner", selected);
  assert.deepEqual([result.submitted, result.skipped], [80,0]);
  assert.equal((await rows("SELECT id FROM hostel_listings WHERE status='PENDING_REVIEW'")).length, 80);
  const retry = await submitHostelRoomRange("owner", selected);
  assert.deepEqual([retry.submitted, retry.skipped], [0,80]);
});

test("one suspended bed prevents partial bulk submission", async () => {
  const row = (await rows("SELECT l.id FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id WHERE r.label='Room 030' LIMIT 1"))[0];
  await turso("UPDATE hostel_listings SET status='SUSPENDED' WHERE id=?", [String(row.id)]);
  await assert.rejects(() => submitHostelRoomRange("owner", { propertyId: "p", prefix: "Room", start: 30, end: 31, width: 3, periodId: "year" }), error => error.code === "INVALID_STATE");
  assert.equal((await rows("SELECT COUNT(*) AS total FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id WHERE r.label IN ('Room 030','Room 031') AND l.status='PENDING_REVIEW'"))[0].total, 0);
});
