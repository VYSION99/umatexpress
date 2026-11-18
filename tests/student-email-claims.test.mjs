import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://student-email-claims.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "student-email-claims-test-session-secret-32-characters";
process.env.AUTH_RECOVERY_SECRET = "student-email-claims-test-recovery-secret-32-characters";

const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });

const accounts = await vite.ssrLoadModule("/lib/student-auth.ts");
const claims = await vite.ssrLoadModule("/lib/student-email-claims.ts");
const eligibilityRoute = await vite.ssrLoadModule("/app/api/auth/student/eligibility/route.ts");
await accounts.ensureStudentAccountsTable();

function seed(id, email, verified = 1) {
  sql.db.prepare(`INSERT INTO student_accounts
    (id,email,name,password_hash,password_salt,password_iterations,email_verified,verification_required,active,created_at,updated_at)
    VALUES (?,?,?,'hash','salt',100000,?,1,1,?,?)`).run(id, email, id, verified, new Date().toISOString(), new Date().toISOString());
}

function latestCode(recipient) {
  const row = sql.db.prepare("SELECT message FROM notification_outbox WHERE template='auth_student_email_verification' AND recipient=? ORDER BY created_at DESC,id DESC LIMIT 1").get(recipient);
  return String(row?.message || "").match(/\b\d{6}\b/)?.[0] || "";
}

test("a verified public account links a student inbox without changing its sign-in email", async () => {
  seed("public-1", "ama@example.com");
  const cookie = (await accounts.studentSessionCookie("public-1", new Request("https://umatexpress.test/"))).split(";")[0];
  const request = new Request("https://umatexpress.test/campus", { headers: { cookie } });
  await assert.rejects(() => accounts.requireStudent(request), /Verify a UMaT student email/);

  await assert.rejects(() => claims.requestStudentEmailClaim("public-1", "ama@another.example"), /UMaT student email/);
  await claims.requestStudentEmailClaim("public-1", "Ama@st.umat.edu.gh");
  const pending = await claims.studentEmailClaim("public-1");
  assert.equal(pending.verified, false);
  assert.equal(pending.studentEmail, "ama@st.umat.edu.gh");
  const code = latestCode("ama@st.umat.edu.gh");
  assert.match(code, /^\d{6}$/);
  assert.ok(!sql.db.prepare("SELECT code_hash FROM student_email_claims WHERE account_id='public-1'").get().code_hash.includes(code));
  await assert.rejects(() => claims.verifyStudentEmailClaim("public-1", "99999"), /six-digit code/);
  assert.equal((await claims.verifyStudentEmailClaim("public-1", code)).verified, true);
  assert.equal((await accounts.requireStudent(request)).email, "ama@example.com");
  assert.equal(await accounts.studentOwnsEmail(request, "ama@example.com"), true);
  assert.equal(await accounts.studentOwnsEmail(request, "ama@st.umat.edu.gh"), true, "linked verified student email is recognized as owned by the account");
  assert.equal(await accounts.studentOwnsEmail(request, "other@st.umat.edu.gh"), false);
  assert.equal(sql.db.prepare("SELECT email FROM student_accounts WHERE id='public-1'").get().email, "ama@example.com");
  await assert.rejects(() => claims.verifyStudentEmailClaim("public-1", code), /incorrect or expired/);
});

test("a student inbox cannot be assigned to two accounts", async () => {
  seed("public-2", "esi@example.com");
  await assert.rejects(() => claims.requestStudentEmailClaim("public-2", "ama@st.umat.edu.gh"), /already linked/);
  seed("student-1", "kojo@st.umat.edu.gh");
  await assert.rejects(() => claims.requestStudentEmailClaim("public-2", "kojo@st.umat.edu.gh"), /already linked/);
  assert.throws(() => seed("student-2", "ama@st.umat.edu.gh"), /already linked/);
});

test("the student access API is private and reports a verified linked address", async () => {
  const guest = await eligibilityRoute.GET(new Request("https://umatexpress.test/api/auth/student/eligibility"));
  assert.equal(guest.status, 401);
  const cookie = (await accounts.studentSessionCookie("public-1", new Request("https://umatexpress.test/"))).split(";")[0];
  const response = await eligibilityRoute.GET(new Request("https://umatexpress.test/api/auth/student/eligibility", { headers: { cookie } }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).studentAccess, { studentEmail: "ama@st.umat.edu.gh", verified: true, expiresAt: "" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const crossOriginPost = await eligibilityRoute.POST(new Request("https://umatexpress.test/api/auth/student/eligibility", {
    method: "POST",
    headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ studentEmail: "ama@st.umat.edu.gh" }),
  }));
  assert.equal(crossOriginPost.status, 403);
});

test("five failed codes close the pending student-email claim", async () => {
  await claims.requestStudentEmailClaim("public-2", "esi@st.umat.edu.gh");
  const code = latestCode("esi@st.umat.edu.gh");
  const wrong = code === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(() => claims.verifyStudentEmailClaim("public-2", wrong), /incorrect or expired/);
  await assert.rejects(() => claims.verifyStudentEmailClaim("public-2", code), /incorrect or expired/);
  assert.equal((await claims.studentEmailClaim("public-2")).verified, false);
});
