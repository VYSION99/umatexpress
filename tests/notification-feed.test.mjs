import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const request = (cookie, init = {}) => new Request("https://umatexpress.test/api/notifications", {
  ...init,
  headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) },
});

test("the feed needs the platform account, exactly like booking does", async () => {
  const route = await vite.ssrLoadModule("/app/api/notifications/route.ts");
  const response = await route.GET(request(null));
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.equal(data.ok, false);
  assert.equal(data.code, "UNAUTHORIZED");

  const patch = await route.PATCH(request(null, { method: "PATCH", body: JSON.stringify({ all: true }) }));
  assert.equal(patch.status, 401);
});

test("the feed reads and marks only the signed-in student's own messages", async () => {
  const previous = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const statements = [];
  const result = (names, rows) => ({ results: [{ type: "ok", response: { result: { cols: names.map((name) => ({ name })), rows: rows.map((row) => row.map((value) => ({ value }))) } } }] });

  globalThis.fetch = async (_url, init) => {
    const { sql, args } = JSON.parse(String(init?.body)).requests[0].stmt;
    statements.push({ sql, args: (args || []).map((arg) => arg.value) });
    if (sql.includes("FROM student_accounts WHERE id = ?")) {
      return Response.json(result(
        ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations"],
        [["acc-1", "ama@st.umat.edu.gh", "Ama", "0555000111", "2026-01-01T00:00:00.000Z", "", 0, 1, "hash", "salt", 100000]],
      ));
    }
    if (sql.includes("FROM notification_outbox")) {
      return Response.json(result(
        ["id", "template", "subject", "message", "reference", "created_at", "read_at"],
        [
          ["n-2", "driver_arrived", "Driver arrived", "Driver arrived at your zone.", "CR-2", "2026-03-02T10:00:00.000Z", null],
          ["n-1", "driver_accepted", "Driver accepted", "Driver accepted you.", "CR-1", "2026-03-01T10:00:00.000Z", "2026-03-01T11:00:00.000Z"],
        ],
      ));
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [], affected_row_count: 1 } } }] });
  };

  try {
    const { studentSessionCookie } = await vite.ssrLoadModule("/lib/student-auth.ts");
    const cookie = (await studentSessionCookie("acc-1", new Request("https://umatexpress.test/"))).split(";")[0];
    const route = await vite.ssrLoadModule("/app/api/notifications/route.ts");

    const response = await route.GET(request(cookie));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.notifications.map((item) => item.subject), ["Driver arrived", "Driver accepted"]);
    assert.deepEqual(data.notifications.map((item) => item.read), [false, true]);
    assert.equal(data.unread, 1);

    // The session, not the request body, decides whose messages come back.
    const read = statements.find((entry) => entry.sql.includes("FROM notification_outbox"));
    assert.match(read.sql, /WHERE recipient = \?/);
    assert.equal(read.args[0], "ama@st.umat.edu.gh");

    const patch = await route.PATCH(request(cookie, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) }));
    assert.equal(patch.status, 200);
    const update = statements.find((entry) => entry.sql.includes("UPDATE notification_outbox SET read_at"));
    assert.match(update.sql, /WHERE recipient = \? AND read_at IS NULL$/);
    assert.equal(update.args[1], "ama@st.umat.edu.gh");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
});
