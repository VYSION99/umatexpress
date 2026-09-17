import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// The account service decides between live Turso and local fallbacks from the
// environment, so the session tests pin that decision rather than inheriting
// whatever the developer happens to have exported.
const savedTurso = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";
after(() => {
  if (savedTurso.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = savedTurso.url;
  if (savedTurso.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = savedTurso.token;
});

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const {
  STUDENT_EMAIL_DOMAIN,
  normalizeStudentEmail,
  validStudentEmail,
  assertStudentEmail,
  assertStudentPassword,
  studentAccountView,
  studentSessionCookie,
  studentAccountFromRequest,
  studentSessionFromRequest,
  clearStudentSessionCookie,
} = await vite.ssrLoadModule("/lib/student-auth.ts");

const request = (cookie) => new Request("https://umatexpress.test/api/auth/student", { headers: cookie ? { cookie } : {} });

test("only UMaT student addresses are accepted", () => {
  assert.equal(STUDENT_EMAIL_DOMAIN, "st.umat.edu.gh");
  assert.equal(validStudentEmail("ama.mensah@st.umat.edu.gh"), true);
  assert.equal(validStudentEmail("ama_123@st.umat.edu.gh"), true);
  assert.equal(validStudentEmail("a@st.umat.edu.gh"), true);
  // Other domains, lookalike hosts and unrelated mailboxes are all rejected.
  assert.equal(validStudentEmail("ama@umat.edu.gh"), false);
  assert.equal(validStudentEmail("ama@stu.umat.edu.gh"), false);
  assert.equal(validStudentEmail("ama@x.st.umat.edu.gh"), false);
  assert.equal(validStudentEmail("ama@st.umat.edu.gh.evil.test"), false);
  assert.equal(validStudentEmail("st.umat.edu.gh@evil.test"), false);
  assert.equal(validStudentEmail("ama@st.umat.edu.gh "), false);
  assert.equal(validStudentEmail("@st.umat.edu.gh"), false);
  assert.equal(validStudentEmail("a..b@st.umat.edu.gh"), false);
  assert.equal(validStudentEmail(""), false);
});

test("emails are normalised before they are stored or compared", () => {
  assert.equal(normalizeStudentEmail("  Ama.Mensah@ST.Umat.edu.GH "), "ama.mensah@st.umat.edu.gh");
  assert.equal(normalizeStudentEmail(42), "");
  assert.equal(normalizeStudentEmail(null), "");
  // Normalising first is what makes the domain check usable on typed input.
  assert.equal(validStudentEmail(normalizeStudentEmail("Ama@st.umat.edu.gh")), true);
});

test("the domain rule fails loudly for the sign-up form", () => {
  assert.throws(() => assertStudentEmail("ama@umat.edu.gh"), /@st\.umat\.edu\.gh/);
  assert.doesNotThrow(() => assertStudentEmail("ama@st.umat.edu.gh"));
});

test("student passwords must clear the same bar as driver passwords", () => {
  assert.doesNotThrow(() => assertStudentPassword("Campus!2026ride"));
  assert.throws(() => assertStudentPassword("short1!A"), /at least 10 characters/);
  assert.throws(() => assertStudentPassword("alllowercase1!"), /at least 10 characters|uppercase/);
  assert.throws(() => assertStudentPassword("NoDigitsHere!"), /number/);
  assert.throws(() => assertStudentPassword("NoSymbol12345"), /symbol/);
});

test("an account view never exposes the stored hash or salt", () => {
  const row = { id: "acc-1", email: "ama@st.umat.edu.gh", name: "Ama", phone: "0555000111", created_at: "2026-01-01T00:00:00.000Z", last_login_at: "", password_hash: "SECRET", password_salt: "SALT", password_iterations: 100000, token_version: 7 };
  const view = studentAccountView(row);
  assert.deepEqual(Object.keys(view).sort(), ["createdAt", "email", "id", "lastLoginAt", "name", "phone"]);
  assert.equal(JSON.stringify(view).includes("SECRET"), false);
  assert.equal(JSON.stringify(view).includes("SALT"), false);
});

test("a session cookie round-trips through the signed payload", async () => {
  const cookie = await studentSessionCookie("acc-1", new Request("http://localhost/"));
  assert.match(cookie, /^umx_student_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes("Secure"), false, "plain http previews must still work");
  const value = cookie.split(";")[0];
  const session = await studentSessionFromRequest(request(value));
  assert.deepEqual(session, { accountId: "acc-1", version: 0 });
  // A secure origin adds the Secure flag.
  const secureCookie = await studentSessionCookie("acc-1", new Request("https://umatexpress.test/"));
  assert.match(secureCookie, /Secure/);
});

test("a tampered or missing session is rejected", async () => {
  const cookie = await studentSessionCookie("acc-1", new Request("http://localhost/"));
  const value = cookie.split(";")[0];
  assert.equal(await studentSessionFromRequest(request(null)), null);
  assert.equal(await studentSessionFromRequest(request("umx_student_session=")), null);
  assert.equal(await studentSessionFromRequest(request(`${value}x`)), null, "signature must cover the payload");
  // Swapping the payload for another account id invalidates the signature.
  const forged = `${Buffer.from(JSON.stringify({ sid: "acc-2", exp: Date.now() + 60000, ver: 0 })).toString("base64url")}.${value.split(".")[1]}`;
  assert.equal(await studentSessionFromRequest(request(`umx_student_session=${forged}`)), null);
  assert.equal(await studentSessionFromRequest(request("umx_student_session=garbage")), null);
});

test("the signed payload carries the account, an expiry and a token version", async () => {
  const cookie = await studentSessionCookie("acc-9", new Request("http://localhost/"));
  const value = decodeURIComponent(cookie.split(";")[0].slice("umx_student_session=".length));
  const payload = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString("utf8"));
  assert.equal(payload.sid, "acc-9");
  assert.equal(payload.ver, 0, "no Turso means no stored token_version to compare against");
  assert.ok(payload.exp > Date.now(), "a session must outlive the sign-in that created it");
});

test("clearing the cookie expires it on every origin shape", () => {
  const cleared = clearStudentSessionCookie(new Request("https://umatexpress.test/"));
  assert.match(cleared, /^umx_student_session=;/);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Secure/);
});

const {
  registerStudent,
  requireStudent,
  updateStudentProfile,
  changeStudentPassword,
} = await vite.ssrLoadModule("/lib/student-auth.ts");

test("a sign-up outside the student domain never reaches the database", async () => {
  await assert.rejects(() => registerStudent({ email: "ama@umat.edu.gh", password: "Campus!2026ride" }), /@st\.umat\.edu\.gh/);
  await assert.rejects(() => registerStudent({ email: "ama@gmail.com", password: "Campus!2026ride" }), /@st\.umat\.edu\.gh/);
  await assert.rejects(() => registerStudent({ email: "ama@st.umat.edu.gh", password: "weakpass" }), /at least 10 characters/);
});

test("a valid sign-up still fails closed when no account store is configured", async () => {
  await assert.rejects(
    () => registerStudent({ email: "ama@st.umat.edu.gh", password: "Campus!2026ride" }),
    /accounts are not configured/,
  );
});

test("every account action needs a session, so viewing stays the only open door", async () => {
  const anonymous = () => new Request("https://umatexpress.test/api/auth/student", { method: "PATCH" });
  assert.equal(await studentSessionFromRequest(anonymous()), null);
  await assert.rejects(() => requireStudent(anonymous()), /Sign in to your UMaTeXPRESS account/);
  await assert.rejects(() => updateStudentProfile(anonymous(), { name: "Ama" }), /Sign in to your UMaTeXPRESS account/);
  await assert.rejects(() => changeStudentPassword(anonymous(), { currentPassword: "old", newPassword: "Campus!2026ride" }), /Sign in to your UMaTeXPRESS account/);
});

test("a session resolves to the stored account, and the lookup SQL stays well formed", async () => {
  const previous = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const statements = [];
  globalThis.fetch = async (_url, init) => {
    const sql = JSON.parse(String(init?.body)).requests[0].stmt.sql;
    statements.push(sql);
    // Only the by-id account lookup returns a row; everything else (schema
    // self-heal, last-login stamp) is a no-op.
    if (sql.includes("FROM student_accounts WHERE id = ?")) {
      const columns = ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations"];
      const values = ["acc-1", "ama@st.umat.edu.gh", "Ama", "0555000111", "2026-01-01T00:00:00.000Z", "", 0, 1, "hash", "salt", 100000];
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [values.map((value) => ({ value }))], cols: columns.map((name) => ({ name })) } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };
  try {
    const cookie = (await studentSessionCookie("acc-1", new Request("http://localhost/"))).split(";")[0];
    const account = await requireStudent(request(cookie));
    assert.deepEqual(account, { id: "acc-1", email: "ama@st.umat.edu.gh", name: "Ama", phone: "0555000111", createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: "" });

    // The token-version probe reads the same table, so the credential columns are
    // what identify the full account lookup.
    const lookup = statements.filter((sql) => sql.includes("FROM student_accounts WHERE id = ?") && sql.includes("password_iterations"));
    assert.equal(lookup.length, 1, "the account is read exactly once per request");
    // A column list that swallowed the FROM clause used to compile and then fail
    // at the database, so the shape is asserted here.
    assert.equal(lookup[0].match(/FROM/g).length, 1, "exactly one FROM in the account lookup");
    assert.ok(lookup[0].indexOf("password_iterations") < lookup[0].indexOf("FROM"), "columns must all precede FROM");
    assert.match(lookup[0], /WHERE id = \? LIMIT 1$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
});

test("an account that was deactivated or had its password changed cannot keep a session", async () => {
  const previous = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  let row = ["acc-1", "ama@st.umat.edu.gh", "Ama", "", "2026-01-01T00:00:00.000Z", "", 0, 1, "hash", "salt", 100000];
  globalThis.fetch = async (_url, init) => {
    const sql = JSON.parse(String(init?.body)).requests[0].stmt.sql;
    if (sql.includes("FROM student_accounts WHERE id = ?")) {
      const columns = ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations"];
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [row.map((value) => ({ value }))], cols: columns.map((name) => ({ name })) } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };
  try {
    const cookie = (await studentSessionCookie("acc-1", new Request("http://localhost/"))).split(";")[0];
    assert.ok(await studentAccountFromRequest(request(cookie)));
    // A password change bumps token_version, which retires the old session.
    row = [...row.slice(0, 6), 1, ...row.slice(7)];
    assert.equal(await studentAccountFromRequest(request(cookie)), null);
    // Deactivating the account retires it too.
    row = [...row.slice(0, 7), 0, ...row.slice(8)];
    assert.equal(await studentAccountFromRequest(request(cookie)), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
});
