import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-room-rate-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const directory = mkdtempSync(join(tmpdir(), "hostel-room-rate-"));
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
    if x['stmt']['sql']=='ROLLBACK' and errors[-1] is None: values.append(None);errors.append(None);continue
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
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, plugins: [{ name: "hostel-room-rate-stubs", enforce: "pre", resolveId(source) { if ((source === "@/lib/hostel-engine/landlord" || source.endsWith("/lib/hostel-engine/landlord.ts"))) return "\0landlord"; if ((source === "@/lib/hostel-engine/onboarding" || source.endsWith("/lib/hostel-engine/onboarding.ts"))) return "\0onboarding"; if ((source === "@/lib/console-audit" || source.endsWith("/lib/console-audit.ts"))) return "\0audit"; }, load(id) { if (id === "\0landlord") return "export async function ensureHostelTables() {}"; if (id === "\0onboarding") return "export async function ensureHostelOnboardingTables() {} export async function ownerReadiness() { return { identityStatus: 'VERIFIED', profileStatus: 'APPROVED' }; }"; if (id === "\0audit") return "export async function consoleAudit() {}"; } }], server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });
const { turso, rowsToObjects } = await vite.ssrLoadModule("/lib/turso.ts");
const { setHostelRoomRate, createHostelListing, updateHostelListing } = await vite.ssrLoadModule("/lib/hostel-engine/listings.ts");
const { saveHostelAiEntry, listHostelAiEntries, listPublicHostelAiEntries, archiveHostelAiEntry } = await vite.ssrLoadModule("/lib/hostel-engine/ai-desk.ts");
await turso("CREATE TABLE campus_schema_meta (id TEXT PRIMARY KEY,version TEXT,applied_at TEXT)");
await turso("CREATE TABLE schema_passes (id TEXT PRIMARY KEY,version TEXT,applied_at TEXT)");
await turso("INSERT INTO schema_passes (id,version,applied_at) VALUES ('hostel_payouts','016_hostel_payouts','now'),('hostelPayoutTransfers','034_hostel_payout_transfer_fee','now')");
await turso("INSERT INTO campus_schema_meta (id,version,applied_at) VALUES ('hostel_payouts','016_hostel_payouts','now'),('hostelPayoutTransfers','034_hostel_payout_transfer_fee','now'),('hostelOwnerOnboarding','039_hostel_owner_onboarding','now'),('hostelFoundation','2026-09-20.3','now'),('hostelRoomBedLayout','041_hostel_room_bed_layout','now'),('hostelCommission3pct','017_hostel_commission_3pct','now')");
await turso("CREATE TABLE hostel_landlords (id TEXT PRIMARY KEY,name TEXT,phone TEXT,email TEXT,organization TEXT,status TEXT,kyc_status TEXT,review_reason TEXT,payout_method TEXT,payout_account_last4 TEXT,payout_bank_code TEXT,payout_bank_name TEXT,payout_account_name TEXT,payout_updated_at TEXT)");
await turso("CREATE TABLE hostel_owner_onboarding (landlord_id TEXT PRIMARY KEY,owner_role TEXT,profile_status TEXT,profile_reason TEXT,payout_status TEXT,payout_reason TEXT,payout_snapshot TEXT)");
await turso("INSERT INTO hostel_landlords VALUES ('owner','Owner','','owner@example.com','','ACTIVE','VERIFIED','','','','','','','')");
await turso("INSERT INTO hostel_owner_onboarding VALUES ('owner','OWNER','APPROVED','','PENDING','','')");
await turso("CREATE TABLE hostel_properties (id TEXT PRIMARY KEY,landlord_id TEXT,name TEXT,status TEXT)");
await turso("CREATE TABLE hostel_rooms (id TEXT PRIMARY KEY,property_id TEXT,label TEXT,status TEXT)");
await turso("CREATE TABLE hostel_spaces (id TEXT PRIMARY KEY,room_id TEXT,label TEXT,status TEXT)");
await turso("CREATE TABLE hostel_periods (id TEXT PRIMARY KEY,name TEXT,active INTEGER,starts_on TEXT,ends_on TEXT)");
await turso("CREATE TABLE hostel_listings (id TEXT PRIMARY KEY,space_id TEXT,period_id TEXT,price INTEGER,status TEXT,review_reason TEXT DEFAULT '',submitted_at TEXT DEFAULT '',reviewed_at TEXT DEFAULT '',reviewed_by TEXT DEFAULT '',created_at TEXT,updated_at TEXT,UNIQUE(space_id,period_id))");
await turso("INSERT INTO hostel_properties VALUES ('p','owner','Green Court','APPROVED')");
await turso("INSERT INTO hostel_rooms VALUES ('r','p','A1','ACTIVE')");
await turso("INSERT INTO hostel_periods VALUES ('year','2026/27',1,'2026-09-01','2027-07-31')");
for (const label of ['A','B','C','D']) await turso("INSERT INTO hostel_spaces VALUES (?,?,?,'AVAILABLE')", [`bed-${label}`, 'r', label]);
await turso("ALTER TABLE hostel_landlords ADD COLUMN commission_bps INTEGER DEFAULT 300");
const listingRows = async () => rowsToObjects(await turso("SELECT l.id,l.space_id,l.price,l.status FROM hostel_listings l ORDER BY l.space_id"));

test("one room rate creates four separate equal-priced beds and reprices them together", async () => {
  const first = await setHostelRoomRate("owner", { roomId: "r", periodId: "year", price: 100000 });
  assert.equal(first.bedCount, 4);
  assert.equal(first.changed, 4);
  assert.deepEqual((await listingRows()).map(row => Number(row.price)), [100000,100000,100000,100000]);
  await turso("UPDATE hostel_listings SET status='APPROVED'");
  const second = await setHostelRoomRate("owner", { roomId: "r", periodId: "year", price: 120000 });
  assert.equal(second.changed, 4);
  assert.deepEqual((await listingRows()).map(row => [Number(row.price), row.status]), [[120000,'DRAFT'],[120000,'DRAFT'],[120000,'DRAFT'],[120000,'DRAFT']]);
});

test("legacy single-bed routes cannot create a different price inside the room", async () => {
  const rows = await listingRows();
  await assert.rejects(() => updateHostelListing("owner", String(rows[0].id), { price: 130000 }), error => error?.code === "INVALID_STATE");
  await turso("DELETE FROM hostel_listings WHERE space_id='bed-D'");
  await assert.rejects(() => createHostelListing("owner", { spaceId: "bed-D", periodId: "year", price: 130000 }), error => error?.code === "INVALID_STATE");
  await setHostelRoomRate("owner", { roomId: "r", periodId: "year", price: 120000 });
  assert.equal((await listingRows()).length, 4);
});

test("a held or occupied bed locks the room rate for that academic year", async () => {
  await turso("UPDATE hostel_spaces SET status='OCCUPIED' WHERE id='bed-A'");
  await assert.rejects(() => setHostelRoomRate("owner", { roomId: "r", periodId: "year", price: 140000 }), error => error?.code === "INVALID_STATE");
  assert.deepEqual((await listingRows()).map(row => Number(row.price)), [120000,120000,120000,120000]);
  await assert.rejects(() => setHostelRoomRate("stranger", { roomId: "r", periodId: "year", price: 120000 }), error => error?.code === "NOT_FOUND");
});

test("staff can maintain property and room information without exposing archived claims", async () => {
  const entries = await saveHostelAiEntry({ landlordId: "owner", propertyId: "p", roomId: "r", title: "Wardrobe", content: "Each bed has a wardrobe.", actor: "owner" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].roomLabel, "A1");
  assert.deepEqual((await listPublicHostelAiEntries("p")).map(item => item.title), ["Wardrobe"]);
  await assert.rejects(() => saveHostelAiEntry({ landlordId: "stranger", propertyId: "p", title: "Fake", content: "Should never be added.", actor: "stranger" }), error => error?.code === "NOT_FOUND");
  await archiveHostelAiEntry({ landlordId: "owner", propertyId: "p", id: entries[0].id, actor: "owner" });
  assert.deepEqual(await listHostelAiEntries("owner", "p"), []);
  assert.deepEqual(await listPublicHostelAiEntries("p"), []);
});
