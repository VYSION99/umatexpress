import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://notification-dispatch-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "UMaTeXPRESS <notices@example.test>";
process.env.CAMPUS_APP_URL = "https://example.test";

const db = new DatabaseSync(":memory:");
const originalFetch = globalThis.fetch;
let providerCalls = 0;
function execute(stmt) {
  try {
    const args = (stmt.args || []).map(arg => arg.type === "null" ? null : arg.type === "integer" ? Number(arg.value) : arg.value);
    const query = db.prepare(stmt.sql);
    if (query.columns().length) {
      const cols = query.columns().map(column => ({ name: column.name }));
      const rows = query.all(...args).map(row => cols.map(({ name }) => row[name] === null ? { type: "null" } : { type: typeof row[name] === "number" ? "integer" : "text", value: String(row[name]) }));
      return { result: { cols, rows, affected_row_count: 0 } };
    }
    const result = query.run(...args);
    return { result: { cols: [], rows: [], affected_row_count: Number(result.changes) } };
  } catch (error) { return { error: { message: error.message } }; }
}
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://api.resend.com/emails") {
    providerCalls += 1;
    return new Response("provider unavailable", { status: 503 });
  }
  assert.ok(String(url).startsWith("https://notification-dispatch-test.turso.io"));
  const body = JSON.parse(init.body);
  return Response.json({ results: body.requests.map(request => {
    if (request.type === "close") return { type: "ok" };
    const result = execute(request.stmt);
    return result.error ? { type: "error", error: result.error } : { type: "ok", response: result };
  }) });
};
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); db.close(); globalThis.fetch = originalFetch; });
const { ensureNotificationsTable, turso } = await vite.ssrLoadModule("/lib/turso.ts");
const { dispatchPendingNotifications } = await vite.ssrLoadModule("/lib/notifications.ts");

test("provider failures stop after three actual sends and retain the failure", async () => {
  await ensureNotificationsTable();
  const id = "retry-three-times";
  const now = new Date().toISOString();
  await turso("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at) VALUES(?,'email','ama@st.umat.edu.gh','driver_arrived','Arrived','Driver arrived','CR-1','PENDING',0,'',?,?)", [id, now, now]);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await dispatchPendingNotifications({ ids: [id] });
    assert.equal(result.failed, 1);
    const row = db.prepare("SELECT attempts,status,last_error FROM notification_outbox WHERE id=?").get(id);
    assert.equal(row.attempts, attempt);
    assert.equal(row.status, attempt === 3 ? "FAILED" : "PENDING");
    assert.match(row.last_error, /Resend HTTP 503/);
    db.prepare("UPDATE notification_outbox SET available_at=? WHERE id=?").run(now, id);
  }
  assert.equal(providerCalls, 3);
  assert.equal((await dispatchPendingNotifications({ ids: [id] })).considered, 0);
});

test("expired authentication proof is redacted without calling the provider", async () => {
  const id = "expired-proof";
  const old = new Date(Date.now() - 60_000).toISOString();
  db.prepare("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at,sensitive,expires_at) VALUES(?,'email','ama@st.umat.edu.gh','auth_login_code','123456','Code: 123456','otp:expired','PENDING',0,'',?,?,1,?)").run(id, old, old, old);
  const before = providerCalls;
  await dispatchPendingNotifications({ ids: [id] });
  const row = db.prepare("SELECT status,subject,message FROM notification_outbox WHERE id=?").get(id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.subject, "Authentication message");
  assert.equal(row.message, "");
  assert.equal(providerCalls, before);
});
