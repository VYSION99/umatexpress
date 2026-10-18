import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://transaction-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
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
