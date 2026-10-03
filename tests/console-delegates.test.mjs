import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const saved = {
  url: process.env.TURSO_DATABASE_URL,
  token: process.env.TURSO_AUTH_TOKEN,
  secret: process.env.CONSOLE_SESSION_SECRET,
};
process.env.TURSO_DATABASE_URL = "https://console-delegates-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
process.env.CONSOLE_SESSION_SECRET = "console-delegate-test-secret-at-least-32-characters";
const directory = mkdtempSync(join(tmpdir(), "console-delegates-"));
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
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, plugins: [{ name: "audit-stub", enforce: "pre", resolveId(source) { if (source === "@/lib/console-audit") return "\0audit"; }, load(id) { if (id === "\0audit") return "export async function consoleAudit() {}"; } }], server: { middlewareMode: true, hmr: false } });
after(async () => {
  await vite.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    const envKey = { url: "TURSO_DATABASE_URL", token: "TURSO_AUTH_TOKEN", secret: "CONSOLE_SESSION_SECRET" }[key];
    if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
  }
});
const { createConsoleAccount, createConsoleSession, consoleAccountFromRequest, requireConsoleRole, setConsolePassword, delegateServiceForPath } = await vite.ssrLoadModule("/lib/console-auth.ts");
const { createAdminDelegate, updateAdminDelegate, listAdminDelegates } = await vite.ssrLoadModule("/lib/console-delegates.ts");
const { turso } = await vite.ssrLoadModule("/lib/turso.ts");
const delegateRoute = await vite.ssrLoadModule("/app/api/console/delegates/route.ts");
const { consoleServicesForRole } = await vite.ssrLoadModule("/components/admin/console-services.ts");
const ownerId = await createConsoleAccount({ name: "Primary Admin", email: "admin@example.com", password: "Admin-Password-123!", role: "ADMIN", status: "ACTIVE" });
const ownerSession = await createConsoleSession({ id: ownerId, role: "ADMIN" });
const request = (path, session) => new Request(`https://console.example.test${path}`, { headers: { cookie: `umx_console_session=${encodeURIComponent(session)}` } });

let delegate;
let delegateSession;
test("only named service grants appear in the delegate directory", async () => {
  delegate = await createAdminDelegate({ name: "Hostel reviewer", email: "reviewer@example.com", password: "Delegate-Password-123!", services: ["hostels"], actor: "admin@example.com" });
  assert.equal(delegate.mustChangePassword, true);
  assert.deepEqual((await listAdminDelegates()).map((entry) => entry.email), ["reviewer@example.com"]);
  assert.deepEqual(consoleServicesForRole("ADMIN", ["hostels"]).map((service) => service.id), ["hostels", "account", "security"]);
  assert.equal((await consoleAccountFromRequest(request("/api/console/delegates", ownerSession)))?.id, ownerId);
  delegateSession = await createConsoleSession({ id: delegate.id, role: "ADMIN" }, { mustChangePassword: true });
  assert.equal((await consoleAccountFromRequest(request("/api/console/session", delegateSession)))?.mustChangePassword, true);
  assert.equal(await consoleAccountFromRequest(request("/api/console/delegates", delegateSession)), null);
  assert.equal(await consoleAccountFromRequest(request("/api/console/payouts", delegateSession)), null);
  await assert.rejects(() => requireConsoleRole(request("/api/console/hostel/verifications", delegateSession), ["ADMIN"]), (error) => error.code === "PASSWORD_CHANGE_REQUIRED");
});

test("first password change activates the delegate, while ungranted routes stay closed", async () => {
  await setConsolePassword(delegate.id, "Changed-Password-456!");
  assert.equal(await consoleAccountFromRequest(request("/api/console/session", delegateSession)), null, "old sessions must be revoked");
  delegateSession = await createConsoleSession({ id: delegate.id, role: "ADMIN" });
  const allowed = await requireConsoleRole(request("/api/console/hostel/verifications", delegateSession), ["ADMIN"]);
  assert.deepEqual(allowed.delegateServices, ["hostels"]);
  assert.equal(await consoleAccountFromRequest(request("/api/console/payouts", delegateSession)), null);
  assert.equal(await consoleAccountFromRequest(request("/api/trips/schedule", delegateSession)), null);
  assert.equal(await consoleAccountFromRequest(request("/api/console/delegates", delegateSession)), null);
  assert.equal(delegateServiceForPath("/api/console/unmapped"), "__owner_only__");
});

test("changing grants or suspending a delegate revokes its current session", async () => {
  await updateAdminDelegate({ id: delegate.id, services: ["payouts"], status: "ACTIVE", actor: "admin@example.com", actorId: ownerId });
  assert.equal(await consoleAccountFromRequest(request("/api/console/hostel/verifications", delegateSession)), null);
  delegateSession = await createConsoleSession({ id: delegate.id, role: "ADMIN" });
  assert.equal(await consoleAccountFromRequest(request("/api/console/hostel/verifications", delegateSession)), null);
  assert.equal((await consoleAccountFromRequest(request("/api/console/payouts", delegateSession)))?.id, delegate.id);
  await updateAdminDelegate({ id: delegate.id, services: ["payouts"], status: "SUSPENDED", actor: "admin@example.com", actorId: ownerId });
  assert.equal(await consoleAccountFromRequest(request("/api/console/payouts", delegateSession)), null);
});


test("only a primary administrator can use delegate management endpoints", async () => {
  const owner = await delegateRoute.GET(request("/api/console/delegates", ownerSession));
  assert.equal(owner.status, 200);
  const denied = await delegateRoute.GET(request("/api/console/delegates", delegateSession));
  assert.equal(denied.status, 401);
});

test("an organizer-review delegate can read schedules but cannot edit them", async () => {
  await updateAdminDelegate({ id: delegate.id, services: ["organizers"], status: "ACTIVE", actor: "admin@example.com", actorId: ownerId });
  delegateSession = await createConsoleSession({ id: delegate.id, role: "ADMIN" });
  assert.equal((await consoleAccountFromRequest(request("/api/trips/schedule?admin=1", delegateSession)))?.id, delegate.id);
  const mutation = new Request("https://console.example.test/api/trips/schedule", { method: "PATCH", headers: { cookie: `umx_console_session=${encodeURIComponent(delegateSession)}` } });
  assert.equal(await consoleAccountFromRequest(mutation), null);
});

test("a missing grant record never turns a delegate into a primary admin", async () => {
  await turso("DELETE FROM console_admin_delegates WHERE account_id=?", [delegate.id]);
  assert.equal(await consoleAccountFromRequest(request("/api/console/session", delegateSession)), null);
  assert.equal(await consoleAccountFromRequest(request("/api/console/delegates", delegateSession)), null);
});
