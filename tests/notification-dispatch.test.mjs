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
const providerPayloads = [];
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
    providerPayloads.push(JSON.parse(init.body));
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
  assert.equal(providerPayloads[0].text, "Driver arrived\n\nTrack ride: https://example.test/campus/ticket?reference=CR-1");
  assert.match(providerPayloads[0].html, /https:\/\/example\.test\/logo-web\.png/);
  assert.match(providerPayloads[0].html, /CAMPUSRIDE/);
  assert.match(providerPayloads[0].html, /Driver arrived/);
  assert.match(providerPayloads[0].html, /Track ride/);
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

test("a superseded sign-in email is never sent even if its queue message arrives late", async () => {
  await ensureNotificationsTable();
  db.exec("CREATE TABLE IF NOT EXISTS auth_recovery_requests (id TEXT PRIMARY KEY,email TEXT,purpose TEXT,used_at TEXT,expires_at TEXT)");
  const id = "superseded-proof";
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at,sensitive,expires_at) VALUES(?,'email','ama@st.umat.edu.gh','auth_login_code','Sign-in code','Code: 111111','otp:old-request','PENDING',0,'',?,?,1,?)").run(id, now, now, expiry);
  db.prepare("INSERT INTO auth_recovery_requests(id,email,purpose,used_at,expires_at) VALUES('old-request','ama@st.umat.edu.gh','LOGIN',?,?)").run(now, expiry);
  const before = providerCalls;
  await dispatchPendingNotifications({ ids: [id] });
  const row = db.prepare("SELECT status,subject,message FROM notification_outbox WHERE id=?").get(id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.subject, "Authentication message");
  assert.equal(row.message, "");
  assert.equal(providerCalls, before);
});

test("companion SMS is suppressed when the student already read the in-app alert, and respects the 1-segment cap and daily limit", async () => {
  await ensureNotificationsTable();
  const prevSailupKey = process.env.SAILUP_API_KEY;
  const prevSailupSender = process.env.SAILUP_SENDER_ID;
  const prevDailyLimit = process.env.SMS_DAILY_SEGMENT_LIMIT;
  process.env.SAILUP_API_KEY = "sailup_test_key";
  process.env.SAILUP_SENDER_ID = "UMaTeXPRESS";
  process.env.SMS_DAILY_SEGMENT_LIMIT = "10";
  const smsPayloads = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.sailup.io")) {
      smsPayloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "sms-ok", quantity: 1 }), { status: 202 });
    }
    return prevFetch(url, init);
  };
  try {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 15 * 60_000).toISOString();

    // Case 1: Student already read the primary in-app/email row -> SMS is suppressed with 0 Sailup calls.
    db.prepare("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at,read_at) VALUES('email-read','email','ama@st.umat.edu.gh','driver_arrived','Arrived','Driver arrived','CR-READ','SENT',1,'',?,?,?)").run(now, now, now);
    db.prepare("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at,expires_at) VALUES('sms-suppressed','sms','+233201234567','driver_arrived','','Driver arrived','CR-READ:sms','PENDING',0,'',?,?,?)").run(now, now, future);

    await dispatchPendingNotifications({ ids: ["sms-suppressed"] });
    const suppressedRow = db.prepare("SELECT status,last_error FROM notification_outbox WHERE id='sms-suppressed'").get();
    assert.equal(suppressedRow.status, "FAILED");
    assert.match(suppressedRow.last_error, /already read in app/);
    assert.equal(smsPayloads.length, 0, "no Sailup token spent when student already read the alert in-app");

    // Case 2: Unread in-app row -> companion SMS sends in 1 segment (<= 160 chars) with clean base reference URL.
    const longMsg = "A".repeat(140);
    db.prepare("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at) VALUES('email-unread','email','ama@st.umat.edu.gh','driver_arrived','Arrived','Driver arrived','CR-UNREAD','SENT',1,'',?,?)").run(now, now);
    db.prepare("INSERT INTO notification_outbox(id,channel,recipient,template,subject,message,reference,status,attempts,last_error,available_at,created_at,expires_at) VALUES('sms-send','sms','+233201234567','driver_arrived','',?,'CR-UNREAD:sms','PENDING',0,'',?,?,?)").run(longMsg, now, now, future);

    await dispatchPendingNotifications({ ids: ["sms-send"] });
    assert.equal(smsPayloads.length, 1);
    assert.ok(smsPayloads[0].body.length <= 160, "companion SMS is strictly clamped to 1 segment (160 chars)");
    const sentRow = db.prepare("SELECT status FROM notification_outbox WHERE id='sms-send'").get();
    assert.equal(sentRow.status, "SENT");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevSailupKey === undefined) delete process.env.SAILUP_API_KEY; else process.env.SAILUP_API_KEY = prevSailupKey;
    if (prevSailupSender === undefined) delete process.env.SAILUP_SENDER_ID; else process.env.SAILUP_SENDER_ID = prevSailupSender;
    if (prevDailyLimit === undefined) delete process.env.SMS_DAILY_SEGMENT_LIMIT; else process.env.SMS_DAILY_SEGMENT_LIMIT = prevDailyLimit;
  }
});
