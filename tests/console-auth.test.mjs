import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHmac } from "node:crypto";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// The console session must not depend on a reachable database to reject a
// forged cookie, so these tests pin the no-Turso path.
const savedTurso = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
delete process.env.ADMIN_SESSION_SECRET;
after(() => {
  if (savedTurso.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = savedTurso.url;
  if (savedTurso.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = savedTurso.token;
});

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const {
  CONSOLE_SESSION_COOKIE,
  createConsoleSession,
  consoleSessionCookie,
  consoleSessionFromRequest,
  requireConsoleRole,
  isConsoleRole,
} = await vite.ssrLoadModule("/lib/console-auth.ts");

const SECRET = "test-console-session-secret-at-least-32-chars";
const account = { id: "console-1", role: "ORGANIZER" };

function requestWith(value, host = "console.example.test") {
  return new Request(`https://${host}/api/console/session`, { headers: value ? { cookie: `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(value)}` } : {} });
}

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function forge(payload, secret) {
  const body = encode(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${mac}`;
}

test("a console session round-trips and keeps its role", async () => {
  const value = await createConsoleSession(account);
  const session = await consoleSessionFromRequest(requestWith(value));
  assert.equal(session.aid, "console-1");
  assert.equal(session.role, "ORGANIZER");
});

test("the console cookie is host-only and HttpOnly", async () => {
  const cookie = await consoleSessionCookie(account, new Request("https://console.example.test/"));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  // No Domain attribute: a console session must never be sent to the public site.
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("a tampered payload is rejected", async () => {
  const value = await createConsoleSession(account);
  const [payload, mac] = value.split(".");
  const escalated = encode(JSON.stringify({ aid: "console-1", role: "ADMIN", exp: Date.now() + 60_000, ver: 0 }));
  assert.equal(await consoleSessionFromRequest(requestWith(`${escalated}.${mac}`)), null);
  assert.equal(await consoleSessionFromRequest(requestWith(`${payload}.${mac}x`)), null);
});

test("a cookie signed with another secret is rejected", async () => {
  const forged = forge({ aid: "console-1", role: "ADMIN", exp: Date.now() + 60_000, ver: 0 }, "some-other-secret-that-is-long-enough-x");
  assert.equal(await consoleSessionFromRequest(requestWith(forged)), null);
});

test("an expired session is rejected even when correctly signed", async () => {
  const expired = forge({ aid: "console-1", role: "ADMIN", exp: Date.now() - 1000, ver: 0 }, SECRET);
  assert.equal(await consoleSessionFromRequest(requestWith(expired)), null);
});

test("an unknown role in the payload is rejected", async () => {
  const forged = forge({ aid: "console-1", role: "SUPERUSER", exp: Date.now() + 60_000, ver: 0 }, SECRET);
  assert.equal(await consoleSessionFromRequest(requestWith(forged)), null);
  assert.equal(isConsoleRole("SUPERUSER"), false);
  assert.equal(isConsoleRole("ADMIN"), true);
});

test("a request with no session cannot reach a console role guard", async () => {
  await assert.rejects(() => requireConsoleRole(requestWith(null), ["ADMIN"]), (error) => error.status === 401);
});
