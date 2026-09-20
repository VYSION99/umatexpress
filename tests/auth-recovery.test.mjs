import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Account recovery and one-time codes, for both account surfaces. The tests
 * drive the engine against a fake Turso, so the rules that make recovery safe
 * can be asserted directly: only hashes are stored, a code is single-use and
 * attempt-limited, an unknown address answers exactly like a known one, and a
 * reset retires every session that existed before it.
 */

process.env.TURSO_DATABASE_URL = "https://auth-recovery-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";
process.env.AUTH_RECOVERY_SECRET = "test-auth-recovery-secret-at-least-32-chars";

const students = [];
const consoles = [];
const requests = [];
const outbox = [];
const audits = [];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const affected = (count) => ok({ affected_row_count: count });

function handle(sql, args) {
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) return ok(table(["version"], [{ version: "test-version" }]));
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta/.test(sql)) return affected(1);
  if (/^PRAGMA table_info/.test(sql)) return ok(empty);
  if (/^INSERT INTO admin_audit_logs/.test(sql)) { audits.push(args); return affected(1); }
  if (/^INSERT INTO notification_outbox/.test(sql)) {
    const [id, , recipient, template, subject, message, reference, , nowIso] = args;
    if (outbox.some((item) => item.reference === reference && item.template === template)) return affected(0);
    outbox.push({ id, recipient, template, subject, message, reference, createdAt: nowIso });
    return affected(1);
  }

  if (/^SELECT id,email,COALESCE\(name,''\) AS name FROM student_accounts WHERE email = \? AND COALESCE\(active,1\) = 1 LIMIT 1/.test(sql)) {
    const row = students.find((item) => item.email === args[0] && item.active === 1);
    return ok(row ? table(["id", "email", "name"], [row]) : empty);
  }
  if (/^SELECT id,email,COALESCE\(name,''\) AS name FROM student_accounts WHERE id = \? AND COALESCE\(active,1\) = 1 LIMIT 1/.test(sql)) {
    const row = students.find((item) => item.id === args[0] && item.active === 1);
    return ok(row ? table(["id", "email", "name"], [row]) : empty);
  }
  if (/^SELECT id,email,COALESCE\(name,''\) AS name,COALESCE\(role,''\) AS role FROM console_accounts WHERE email = \? AND status = 'ACTIVE' LIMIT 1/.test(sql)) {
    const row = consoles.find((item) => item.email === args[0] && item.status === "ACTIVE");
    return ok(row ? table(["id", "email", "name", "role"], [row]) : empty);
  }
  if (/^SELECT id,email,COALESCE\(name,''\) AS name,COALESCE\(role,''\) AS role FROM console_accounts WHERE id = \? AND status = 'ACTIVE' LIMIT 1/.test(sql)) {
    const row = consoles.find((item) => item.id === args[0] && item.status === "ACTIVE");
    return ok(row ? table(["id", "email", "name", "role"], [row]) : empty);
  }

  if (/^INSERT INTO auth_recovery_requests/.test(sql)) {
    const [id, scope, accountId, email, purpose, tokenHash, codeHash, expiresAt, createdAt, updatedAt] = args;
    requests.push({ id, scope, account_id: accountId, email, purpose, token_hash: tokenHash, code_hash: codeHash, attempts: 0, expires_at: expiresAt, used_at: "", created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (/^SELECT id,account_id,code_hash,token_hash,COALESCE\(attempts,0\) AS attempts,expires_at,COALESCE\(used_at,''\) AS used_at\s+FROM auth_recovery_requests\s+WHERE scope = \? AND email = \?/.test(sql)) {
    const rows = requests.filter((item) => item.scope === args[0] && item.email === args[1] && item.purpose === args[2] && item.used_at === "");
    return ok(rows.length ? table(["id", "account_id", "code_hash", "token_hash", "attempts", "expires_at", "used_at"], rows) : empty);
  }
  if (/WHERE scope = \? AND purpose = 'RESET' AND token_hash = \? AND used_at = ''/.test(sql)) {
    const rows = requests.filter((item) => item.scope === args[0] && item.purpose === "RESET" && item.token_hash === args[1] && item.used_at === "");
    return ok(rows.length ? table(["id", "account_id", "code_hash", "token_hash", "attempts", "expires_at", "used_at"], rows) : empty);
  }
  if (/^UPDATE auth_recovery_requests SET used_at = \?, updated_at = \? WHERE id = \?/.test(sql)) {
    const row = requests.find((item) => item.id === args[2]);
    if (row) Object.assign(row, { used_at: args[0], updated_at: args[1] });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE auth_recovery_requests SET attempts = COALESCE\(attempts,0\) \+ 1/.test(sql)) {
    const row = requests.find((item) => item.id === args[1]);
    if (row) { row.attempts = Number(row.attempts || 0) + 1; row.updated_at = args[0]; }
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE student_accounts SET password_hash = \?/.test(sql)) {
    const [hash, salt, iterations, updatedAt, id] = args;
    const row = students.find((item) => item.id === id);
    if (row) Object.assign(row, { password_hash: hash, password_salt: salt, password_iterations: iterations, token_version: Number(row.token_version || 0) + 1, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE console_accounts SET password_hash = \?/.test(sql)) {
    const [hash, salt, iterations, updatedAt, id] = args;
    const row = consoles.find((item) => item.id === id);
    if (row) Object.assign(row, { password_hash: hash, password_salt: salt, password_iterations: iterations, token_version: Number(row.token_version || 0) + 1, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  requestLoginCode, requestPasswordReset, resetPassword, verifyLoginCode,
} = await vite.ssrLoadModule("/lib/auth-recovery.ts");

const resetMail = () => outbox.filter((item) => item.template === "auth_password_reset").at(-1);
const otpMail = () => outbox.filter((item) => item.template === "auth_login_code").at(-1);
const codeIn = (mail) => String(mail?.message || "").match(/\b(\d{6})\b/)?.[1] || "";
const tokenIn = (mail) => String(mail?.message || "").match(/token=([A-Za-z0-9_-]+)/)?.[1] || "";

function seed() {
  students.length = 0; consoles.length = 0; requests.length = 0; outbox.length = 0; audits.length = 0;
  students.push({
    id: "student-1", email: "ama@st.umat.edu.gh", name: "Ama Mensah", active: 1, token_version: 3,
    password_hash: "", password_salt: "", password_iterations: 100_000, updated_at: "",
  });
  consoles.push({
    id: "console-1", email: "owusu@example.com", name: "Mr. Owusu", role: "LANDLORD", status: "ACTIVE", token_version: 2,
    password_hash: "", password_salt: "", password_iterations: 100_000, updated_at: "",
  });
}

test("a reset link stores only a hash and works exactly once", async () => {
  seed();
  const asked = await requestPasswordReset({ scope: "STUDENT", email: "Ama@ST.Umat.edu.GH", origin: "https://umatexpress.test" });
  assert.equal(asked.requested, true);
  assert.equal(asked.delivered, true);
  const mail = resetMail();
  assert.equal(mail.recipient, "ama@st.umat.edu.gh", "the student address is normalised before it is stored or mailed");
  const token = tokenIn(mail);
  const code = codeIn(mail);
  assert.ok(token && code, "the mail carries both a link token and a code");

  // The row holds the HMAC of each secret, never the secret itself.
  const row = requests.at(-1);
  assert.equal(row.token_hash.includes(token), false);
  assert.equal(row.code_hash.includes(code), false);
  assert.equal(row.used_at, "");

  const result = await resetPassword({ scope: "STUDENT", token, newPassword: "NewPassw0rd!x" });
  assert.equal(result.reset, true);
  assert.equal(result.email, "ama@st.umat.edu.gh");
  assert.equal(students[0].token_version, 4, "a reset retires every older session");
  assert.match(mail.message, /reset/i);
  assert.equal(outbox.filter((item) => item.template === "auth_password_changed").length, 1);

  await assert.rejects(
    () => resetPassword({ scope: "STUDENT", token, newPassword: "AnotherPassw0rd!x" }),
    (error) => error?.code === "INVALID_STATE",
    "a link that has been used cannot be replayed",
  );
});

test("the emailed code finishes the reset, and stops after five wrong guesses", async () => {
  seed();
  await requestPasswordReset({ scope: "STUDENT", email: "ama@st.umat.edu.gh", origin: "https://umatexpress.test" });
  const code = codeIn(resetMail());
  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => resetPassword({ scope: "STUDENT", email: "ama@st.umat.edu.gh", code: wrong, newPassword: "NewPassw0rd!x" }),
      (error) => error?.code === "UNAUTHORIZED",
    );
  }
  await assert.rejects(
    () => resetPassword({ scope: "STUDENT", email: "ama@st.umat.edu.gh", code, newPassword: "NewPassw0rd!x" }),
    (error) => error?.code === "UNAUTHORIZED",
    "the row is burned once the attempt limit is passed",
  );
  assert.equal(students[0].token_version, 3, "no password was written");

  // A fresh request starts the count over.
  await requestPasswordReset({ scope: "STUDENT", email: "ama@st.umat.edu.gh", origin: "https://umatexpress.test" });
  const fresh = codeIn(resetMail());
  assert.equal((await resetPassword({ scope: "STUDENT", email: "ama@st.umat.edu.gh", code: fresh, newPassword: "NewPassw0rd!x" })).reset, true);
  assert.equal(students[0].token_version, 4);
});

test("an unknown address answers exactly like a known one", async () => {
  seed();
  const asked = await requestPasswordReset({ scope: "STUDENT", email: "nobody@st.umat.edu.gh", origin: "https://umatexpress.test" });
  assert.deepEqual(asked.requested, true);
  assert.equal(asked.delivered, false);
  assert.equal(outbox.length, 0, "no mail is sent, but the answer does not say so");

  // The same for the console surface, and for an account that is not active.
  consoles[0].status = "SUSPENDED";
  const consoleAsk = await requestPasswordReset({ scope: "CONSOLE", email: "owusu@example.com", origin: "https://console.umatexpress.test" });
  assert.equal(consoleAsk.requested, true);
  assert.equal(consoleAsk.delivered, false);
  assert.equal(outbox.length, 0);
});

test("the console reset link points at the console and enforces the role policy", async () => {
  seed();
  await requestPasswordReset({ scope: "CONSOLE", email: "owusu@example.com", origin: "https://console.umatexpress.test" });
  const mail = resetMail();
  assert.match(mail.message, /console\.umatexpress\.test\/console\/reset-password/, "the console link stays on the console host");

  await assert.rejects(
    () => resetPassword({ scope: "CONSOLE", token: tokenIn(mail), newPassword: "short" }),
    (error) => error?.code === "VALIDATION_ERROR",
    "a landlord password still needs ten characters",
  );
  const result = await resetPassword({ scope: "CONSOLE", token: tokenIn(mail), newPassword: "Landlord@2026" });
  assert.equal(result.reset, true);
  assert.equal(consoles[0].token_version, 3);
  assert.equal(audits.length >= 1, true, "a console reset is audited");
});

test("an expired link is refused and burned", async () => {
  seed();
  const asked = await requestPasswordReset({ scope: "STUDENT", email: "ama@st.umat.edu.gh", origin: "https://umatexpress.test" });
  assert.equal(asked.delivered, true);
  requests.at(-1).expires_at = "2000-01-01T00:00:00.000Z";
  await assert.rejects(
    () => resetPassword({ scope: "STUDENT", token: tokenIn(resetMail()), newPassword: "NewPassw0rd!x" }),
    (error) => error?.code === "INVALID_STATE" && /expired/.test(error.message),
  );
  assert.notEqual(requests.at(-1).used_at, "", "an expired link cannot be tried again later");
});

test("a one-time code signs the right account in, once", async () => {
  seed();
  const asked = await requestLoginCode({ scope: "STUDENT", email: "ama@st.umat.edu.gh" });
  assert.equal(asked.delivered, true);
  const code = codeIn(otpMail());
  assert.equal(await verifyLoginCode({ scope: "STUDENT", email: "ama@st.umat.edu.gh", code: "999999" }), null, "a wrong code is not a sign-in");

  const account = await verifyLoginCode({ scope: "STUDENT", email: "ama@st.umat.edu.gh", code });
  assert.equal(account.id, "student-1");
  assert.equal(account.email, "ama@st.umat.edu.gh");
  assert.equal(await verifyLoginCode({ scope: "STUDENT", email: "ama@st.umat.edu.gh", code }), null, "a code works once");
});

test("a one-time code is scoped: a student code cannot open a console account", async () => {
  seed();
  await requestLoginCode({ scope: "STUDENT", email: "ama@st.umat.edu.gh" });
  const code = codeIn(otpMail());
  assert.equal(await verifyLoginCode({ scope: "CONSOLE", email: "owusu@example.com", code }), null);

  await requestLoginCode({ scope: "CONSOLE", email: "owusu@example.com" });
  const consoleCode = codeIn(otpMail());
  const account = await verifyLoginCode({ scope: "CONSOLE", email: "owusu@example.com", code: consoleCode });
  assert.equal(account.role, "LANDLORD");
});

test("an unknown address never receives a sign-in code", async () => {
  seed();
  const asked = await requestLoginCode({ scope: "CONSOLE", email: "ghost@example.com" });
  assert.equal(asked.requested, true);
  assert.equal(asked.delivered, false);
  assert.equal(outbox.length, 0);
});
