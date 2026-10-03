import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const writes = [];
const account = { id: "owner-1", email: "owner@example.com", name: "Ama Owner", phone: "0241234567", role: "LANDLORD", status: "ACTIVE" };
globalThis.__consoleAccountFixture = { writes, account };
const stubs = new Map([
  ["@/lib/console-auth", 'export async function consoleAccountFromRequest(request) { return request.headers.get("x-test-user") ? globalThis.__consoleAccountFixture.account : null; } export async function ensureConsoleAccountsTable() {}'],
  ["@/lib/turso", 'export async function turso(sql,args) { globalThis.__consoleAccountFixture.writes.push({sql,args}); return {affected_row_count:1}; }'],
  ["@/lib/console-audit", 'export async function consoleAudit() {}'],
  ["@/lib/rate-limit", 'export async function rateLimit() { return {ok:true}; } export function rateLimitResponse() { throw Error("unexpected rate limit"); }'],
]);
const vite = await createServer({
  configFile: false, appType: "custom", root,
  resolve: { alias: { "@": root } },
  plugins: [{
    name: "account-api-fixtures", enforce: "pre",
    resolveId(source) {
      for (const key of stubs.keys()) {
        if (source === key || source.endsWith(key.slice(1)) || source.endsWith(key.slice(1) + ".ts")) return "\0account:" + key;
      }
    },
    load(id) { if (id.startsWith("\0account:")) return stubs.get(id.slice("\0account:".length)); },
  }],
  server: { middlewareMode: true, hmr: false },
});
after(async () => { await vite.close(); delete globalThis.__consoleAccountFixture; });
const { GET, PATCH } = await vite.ssrLoadModule("/app/api/console/account/route.ts");
const url = "https://console.example.test/api/console/account";
const request = (method, body, signedIn = true) => new Request(url, {
  method, headers: { ...(signedIn ? { "x-test-user": "1" } : {}), ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("the account profile is private to the signed-in console account", async () => {
  assert.equal((await GET(request("GET", null, false))).status, 401);
  const response = await GET(request("GET"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).profile, { name: account.name, email: account.email, phone: account.phone, role: account.role, status: account.status });
});

test("profile updates validate input and only change the signed-in account's contact fields", async () => {
  assert.equal((await PATCH(request("PATCH", { name: "New Name" }, false))).status, 401);
  assert.equal((await PATCH(request("PATCH", { name: "A", phone: "0241234567" }))).status, 400);
  assert.equal((await PATCH(request("PATCH", { name: "New Name", phone: "abc" }))).status, 400);
  assert.equal(writes.length, 0);
  const response = await PATCH(request("PATCH", { name: "  Ama   Mensah ", phone: "+233 241234567", role: "ADMIN", email: "attacker@example.com" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.name, "Ama Mensah");
  assert.match(writes[0].sql, /UPDATE console_accounts SET name=\?,phone=\?/);
  assert.deepEqual(writes[0].args.slice(0, 2), ["Ama Mensah", "+233 241234567"]);
  assert.equal(writes[0].args.at(-1), account.id);
  assert.ok(!writes[0].sql.includes("role=") && !writes[0].sql.includes("email="));
});
