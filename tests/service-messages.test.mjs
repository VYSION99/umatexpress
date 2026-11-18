import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-chars";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
after(async () => vite.close());

test("service messages: CampusRide participant authorization and lifecycle gates", async () => {
  const previous = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const statements = [];

  const ok = (result) => ({ type: "ok", response: { result: result || { cols: [], rows: [] } } });
  const table = (names, rows) => ok({
    cols: names.map((name) => ({ name })),
    rows: rows.map((row) => row.map((value) => ({ type: typeof value === "number" ? "integer" : "text", value }))),
  });
  const affected = (count) => ok({ cols: [], rows: [], affected_row_count: count });

  let mockRideStatus = "ACCEPTED_BY_DRIVER";

  function handle(rawSql, args) {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    if (/^SELECT version FROM schema_passes/.test(sql)) return table(["version"], [["1"]]);
    if (/^INSERT OR REPLACE INTO schema_passes/.test(sql)) return affected(1);
    if (/^CREATE |^ALTER /.test(sql)) return ok();

    if (sql.includes("FROM student_accounts WHERE id = ?")) {
      const id = args[0];
      if (id === "acc-student") {
        return table(
          ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations", "email_verified", "verification_required"],
          [["acc-student", "kofi@st.umat.edu.gh", "Kofi", "0555000111", "2026-01-01T00:00:00.000Z", "", 0, 1, "hash", "salt", 100000, 1, 0]],
        );
      }
      if (id === "acc-stranger") {
        return table(
          ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations", "email_verified", "verification_required"],
          [["acc-stranger", "stranger@st.umat.edu.gh", "Stranger", "0555999999", "2026-01-01T00:00:00.000Z", "", 0, 1, "hash", "salt", 100000, 1, 0]],
        );
      }
    }

    if (sql.includes("FROM campus_queue_entries q")) {
      return table(
        ["id", "reference", "passenger_name", "phone", "email", "queue_status", "ride_id", "driver_id", "driver_name", "driver_email"],
        [["q-101", "CR-101", "Kofi", "0555000111", "kofi@st.umat.edu.gh", mockRideStatus, "ride-1", "d-1", "Kwame Driver", "kwame@driver.umat.edu.gh"]],
      );
    }

    if (sql.includes("FROM service_messages WHERE service = ? AND reference = ?")) {
      return table(
        ["id", "service", "reference", "sender_role", "sender_id", "sender_name", "content", "read_at", "created_at"],
        [["m-1", "campus", "CR-101", "DRIVER", "d-1", "Kwame Driver", "Arriving in 2 minutes", "", "2026-03-01T12:00:00.000Z"]],
      );
    }

    return affected(1);
  }

  globalThis.fetch = async (_url, init) => {
    const requests = JSON.parse(String(init?.body)).requests || [];
    const results = requests.map((req) => {
      const sql = req.stmt?.sql || "";
      const args = (req.stmt?.args || []).map((a) => a.value);
      statements.push({ sql, args });
      return handle(sql, args);
    });
    return Response.json({ results });
  };

  try {
    const { studentSessionCookie } = await vite.ssrLoadModule("/lib/student-auth.ts");
    const studentCookie = (await studentSessionCookie("acc-student", new Request("https://umatexpress.test/"))).split(";")[0];
    const strangerCookie = (await studentSessionCookie("acc-stranger", new Request("https://umatexpress.test/"))).split(";")[0];
    const route = await vite.ssrLoadModule("/app/api/messages/route.ts");

    // 1. Unrelated user gets 403 FORBIDDEN
    const strangerReq = new Request("https://umatexpress.test/api/messages?service=campus&reference=CR-101", {
      headers: { cookie: strangerCookie },
    });
    const strangerRes = await route.GET(strangerReq);
    assert.equal(strangerRes.status, 403);
    const strangerBody = await strangerRes.json();
    assert.equal(strangerBody.ok, false);

    // 2. Student owner can fetch messages and chips
    const studentReq = new Request("https://umatexpress.test/api/messages?service=campus&reference=CR-101", {
      headers: { cookie: studentCookie },
    });
    const studentRes = await route.GET(studentReq);
    assert.equal(studentRes.status, 200);
    const studentData = await studentRes.json();
    assert.equal(studentData.ok, true);
    assert.equal(studentData.participant.role, "STUDENT");
    assert.equal(studentData.participant.canSend, true);
    assert.equal(studentData.messages.length, 1);
    assert.ok(studentData.chips.includes("I am at the pickup zone"));

    // 3. Student can send message during active ride
    const postReq = new Request("https://umatexpress.test/api/messages", {
      method: "POST",
      headers: {
        cookie: studentCookie,
        "content-type": "application/json",
        origin: "https://umatexpress.test",
      },
      body: JSON.stringify({
        service: "campus",
        reference: "CR-101",
        content: "I am at the pickup zone",
      }),
    });
    const postRes = await route.POST(postReq);
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.ok, true);
    assert.equal(postData.message.content, "I am at the pickup zone");

    // 4. Verify 5-minute bucket notification reference
    const notifInsert = statements.find((s) => s.sql.includes("INSERT INTO notification_outbox"));
    assert.ok(notifInsert, "Notification should be queued to counterpart");
    const bucket = Math.floor(Date.now() / 300_000);
    assert.equal(notifInsert.args[6], `msg:campus:CR-101:${bucket}`);
    assert.equal(notifInsert.args[2], "kwame@driver.umat.edu.gh");

    // 5. Lifecycle gate: when ride is completed, messages cannot be sent
    mockRideStatus = "COMPLETED";
    const completedPostReq = new Request("https://umatexpress.test/api/messages", {
      method: "POST",
      headers: {
        cookie: studentCookie,
        "content-type": "application/json",
        origin: "https://umatexpress.test",
      },
      body: JSON.stringify({
        service: "campus",
        reference: "CR-101",
        content: "Thanks driver!",
      }),
    });
    const completedRes = await route.POST(completedPostReq);
    assert.equal(completedRes.status, 409);
    const completedBody = await completedRes.json();
    assert.equal(completedBody.code, "INVALID_STATE");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
});

test("service messages: Print & Copy quote staff/student exchange and expiry gates", async () => {
  const previous = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const statements = [];

  const ok = (result) => ({ type: "ok", response: { result: result || { cols: [], rows: [] } } });
  const table = (names, rows) => ok({
    cols: names.map((name) => ({ name })),
    rows: rows.map((row) => row.map((value) => ({ type: typeof value === "number" ? "integer" : "text", value }))),
  });
  const affected = (count) => ok({ cols: [], rows: [], affected_row_count: count });

  let mockQuoteStatus = "NEW";
  let mockQuoteExpiry = new Date(Date.now() + 86_400_000).toISOString();

  function handle(rawSql, args) {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    if (/^SELECT version FROM schema_passes/.test(sql)) return table(["version"], [["1"]]);
    if (/^INSERT OR REPLACE INTO schema_passes/.test(sql)) return affected(1);
    if (/^CREATE |^ALTER /.test(sql)) return ok();

    if (sql.includes("FROM student_accounts WHERE id = ?")) {
      return table(
        ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations", "email_verified", "verification_required"],
        [["acc-student", "ama@st.umat.edu.gh", "Ama", "0555000333", "2026-01-01T00:00:00.000Z", "", 0, 1, "hash", "salt", 100000, 1, 0]],
      );
    }

    if (sql.includes("FROM console_accounts WHERE id = ?")) {
      return table(
        ["id", "email", "name", "phone", "role", "profile_id", "status", "must_change_password", "created_at", "last_login_at", "token_version", "password_iterations"],
        [["admin-1", "admin@umat.edu.gh", "Print Admin", "0555999000", "ADMIN", "", "ACTIVE", 0, "2026-01-01T00:00:00.000Z", "", 0, 100000]],
      );
    }

    if (sql.includes("FROM print_copy_quotes q")) {
      return table(
        ["id", "reference", "student_id", "student_name", "student_email", "status", "expires_at", "provider_name"],
        [["q-99", "PC-99", "acc-student", "Ama", "ama@st.umat.edu.gh", mockQuoteStatus, mockQuoteExpiry, "Campus Print Hub"]],
      );
    }

    if (sql.includes("FROM print_copy_settings WHERE id='GLOBAL'")) {
      return table(
        ["quotes_enabled", "support_owner", "updated_at"],
        [[1, "print-support@umat.edu.gh", "2026-01-01T00:00:00.000Z"]],
      );
    }

    if (sql.includes("FROM service_messages WHERE service = ? AND reference = ?")) {
      return table(
        ["id", "service", "reference", "sender_role", "sender_id", "sender_name", "content", "read_at", "created_at"],
        [],
      );
    }

    return affected(1);
  }

  globalThis.fetch = async (_url, init) => {
    const requests = JSON.parse(String(init?.body)).requests || [];
    const results = requests.map((req) => {
      const sql = req.stmt?.sql || "";
      const args = (req.stmt?.args || []).map((a) => a.value);
      statements.push({ sql, args });
      return handle(sql, args);
    });
    return Response.json({ results });
  };

  try {
    const { studentSessionCookie } = await vite.ssrLoadModule("/lib/student-auth.ts");
    const { consoleSessionCookie } = await vite.ssrLoadModule("/lib/console-auth.ts");
    const studentCookie = (await studentSessionCookie("acc-student", new Request("https://umatexpress.test/"))).split(";")[0];
    const adminCookie = (await consoleSessionCookie({ id: "admin-1", role: "ADMIN" }, new Request("https://umatexpress.test/"))).split(";")[0];
    const route = await vite.ssrLoadModule("/app/api/messages/route.ts");

    // 1. Staff can view quote thread
    const staffReq = new Request("https://umatexpress.test/api/messages?service=print-copy&reference=PC-99", {
      headers: { cookie: adminCookie },
    });
    const staffRes = await route.GET(staffReq);
    assert.equal(staffRes.status, 200);
    const staffData = await staffRes.json();
    assert.equal(staffData.participant.role, "STAFF");
    assert.equal(staffData.participant.canSend, true);

    // 2. Staff sends quote estimate
    const staffPostReq = new Request("https://umatexpress.test/api/messages", {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
        origin: "https://umatexpress.test",
      },
      body: JSON.stringify({
        service: "print-copy",
        reference: "PC-99",
        content: "We can print 50 spiral-bound copies for GHS 120. Turnaround: 2 hours.",
      }),
    });
    const staffPostRes = await route.POST(staffPostReq);
    assert.equal(staffPostRes.status, 200);
    const staffPostData = await staffPostRes.json();
    assert.equal(staffPostData.ok, true);

    // Verify notification queued to student
    const notif = statements.find((s) => s.sql.includes("INSERT INTO notification_outbox"));
    assert.ok(notif);
    assert.equal(notif.args[2], "ama@st.umat.edu.gh");
    const bucket = Math.floor(Date.now() / 300_000);
    assert.equal(notif.args[6], `msg:print-copy:PC-99:${bucket}`);

    // 3. Expired quote cannot accept messages
    mockQuoteExpiry = new Date(Date.now() - 10_000).toISOString();
    const expiredReq = new Request("https://umatexpress.test/api/messages", {
      method: "POST",
      headers: {
        cookie: studentCookie,
        "content-type": "application/json",
        origin: "https://umatexpress.test",
      },
      body: JSON.stringify({
        service: "print-copy",
        reference: "PC-99",
        content: "Can we still do this?",
      }),
    });
    const expiredRes = await route.POST(expiredReq);
    assert.equal(expiredRes.status, 409);
    const expiredBody = await expiredRes.json();
    assert.equal(expiredBody.code, "INVALID_STATE");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
});
