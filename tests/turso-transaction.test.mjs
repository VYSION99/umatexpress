import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://transaction-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const directory = mkdtempSync(join(tmpdir(), "hostel-transaction-"));
const database = join(directory, "test.sqlite");
// Execute the actual SQL against SQLite, interpreting Hrana's conditional steps.
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
            def condition(value):
                if not value: return True
                if value['type']=='ok': return values[value['step']] is not None
                if value['type']=='not': return not condition(value['cond'])
                if value['type']=='and': return all(condition(c) for c in value['conds'])
                raise Exception('Unknown batch condition')
            for step in request['batch']['steps']:
                value=None; error=None
                if condition(step.get('condition')):
                    try: value=execute(step['stmt'])
                    except Exception as exc: error={'message':str(exc)}
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
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });
const { turso, tursoTransaction, rowsToObjects } = await vite.ssrLoadModule("/lib/turso.ts");
await turso("CREATE TABLE beds (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
await turso("CREATE TABLE bookings (reference TEXT PRIMARY KEY, bed TEXT NOT NULL UNIQUE)");
await turso("INSERT INTO beds VALUES ('a','AVAILABLE'),('b','AVAILABLE')");
const claim = (bed, reference) => tursoTransaction([
  { sql: "UPDATE beds SET status='RESERVED' WHERE id=? AND status='AVAILABLE'", args: [bed] },
  { sql: "INSERT INTO bookings SELECT ?,? WHERE changes()=1", args: [reference, bed] },
]);
test("atomic claim commits both writes and a second claimant inserts nothing", async () => {
  const first = await claim("a", "one");
  assert.equal(first[0].affected_row_count, 1);
  assert.equal(first[1].affected_row_count, 1);
  const second = await claim("a", "two");
  assert.equal(second[0].affected_row_count, 0);
  assert.equal(second[1].affected_row_count, 0);
  assert.equal(rowsToObjects(await turso("SELECT COUNT(*) AS count FROM bookings"))[0].count, 1);
});
test("insert constraint failure rolls back the claim and leaves the connection usable", async () => {
  await assert.rejects(claim("b", "one"), /UNIQUE constraint/);
  assert.equal(rowsToObjects(await turso("SELECT status FROM beds WHERE id='b'"))[0].status, "AVAILABLE");
  const retry = await claim("b", "three");
  assert.equal(retry[1].affected_row_count, 1);
});
