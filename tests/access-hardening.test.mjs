import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

function snapshotEnv(names) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
}

test("the platform identity header is ignored unless explicitly trusted", async () => {
  const restore = snapshotEnv(["ADMIN_EMAILS", "TRUST_PLATFORM_IDENTITY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.TRUST_PLATFORM_IDENTITY;
  process.env.ADMIN_EMAILS = "admin@example.com";
  try {
    const { adminEmailFromRequest } = await vite.ssrLoadModule("/lib/admin-auth.ts");
    const spoofed = new Request("http://localhost/api/admin/bookings", { headers: { "oai-authenticated-user-email": "admin@example.com" } });

    // Default deployment: the client-controlled header must not authenticate.
    assert.equal(await adminEmailFromRequest(spoofed), null);

    // Opt-in for the workspace host that strips and sets the header itself.
    process.env.TRUST_PLATFORM_IDENTITY = "true";
    assert.equal(await adminEmailFromRequest(spoofed), "admin@example.com");
  } finally {
    restore();
  }
});

test("changing the admin password retires previously issued sessions", async () => {
  const restore = snapshotEnv(["ADMIN_EMAILS", "ADMIN_SESSION_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.ADMIN_SESSION_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  let epoch = 0;

  globalThis.fetch = async (url, options = {}) => {
    const sql = options && typeof options.body === "string" ? JSON.parse(options.body).requests?.[0]?.stmt?.sql || "" : "";
    if (String(url).includes("/v2/pipeline") && sql.includes("FROM admin_credentials WHERE email = ?")) {
      return Response.json({ results: [{ type: "ok", response: { result: {
        rows: [[{ value: "hash" }, { value: "salt" }, { value: 100_000 }, { value: epoch }]],
        cols: [{ name: "password_hash" }, { name: "password_salt" }, { name: "password_iterations" }, { name: "session_epoch" }],
      } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };

  try {
    const { createAdminSession, adminEmailFromRequest } = await vite.ssrLoadModule("/lib/admin-auth.ts");
    const session = await createAdminSession("admin@example.com");
    const request = new Request("http://localhost/api/admin/bookings", { headers: { cookie: `umx_admin_session=${encodeURIComponent(session)}` } });

    assert.equal(await adminEmailFromRequest(request), "admin@example.com");
    epoch = 1; // a password change bumped the stored epoch
    assert.equal(await adminEmailFromRequest(request), null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("repeated failures lock a subject out and clearing resets it", async () => {
  const restore = snapshotEnv(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    const { authGuardStatus, authGuardFailure, authGuardClear } = await vite.ssrLoadModule("/lib/auth-guard.ts");
    const subject = `lockout-${Date.now()}@example.com`;

    for (let attempt = 0; attempt < 5; attempt++) await authGuardFailure("test-login", subject);
    const locked = await authGuardStatus("test-login", subject);
    assert.equal(locked.locked, true);
    assert.ok(locked.retryAfter > 0);

    await authGuardClear("test-login", subject);
    assert.equal((await authGuardStatus("test-login", subject)).locked, false);
  } finally {
    restore();
  }
});

test("driver sessions carry the stored token version and survive tampering checks", async () => {
  const restore = snapshotEnv(["ADMIN_SESSION_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
  process.env.ADMIN_SESSION_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const sql = options && typeof options.body === "string" ? JSON.parse(options.body).requests?.[0]?.stmt?.sql || "" : "";
    if (String(url).includes("/v2/pipeline") && sql.includes("COALESCE(token_version,0) AS token_version FROM campus_drivers WHERE id = ? LIMIT 1")) {
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [[{ value: 4 }]], cols: [{ name: "token_version" }] } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };

  try {
    const { createDriverSession, driverSessionFromRequest } = await vite.ssrLoadModule("/lib/campus-engine/driver-auth.ts");
    const token = await createDriverSession("drv-1");
    const request = new Request("http://localhost/api/driver/me", { headers: { cookie: `umx_driver_session=${encodeURIComponent(token)}` } });
    const session = await driverSessionFromRequest(request);
    assert.deepEqual(session, { driverId: "drv-1", version: 4 });

    const tampered = new Request("http://localhost/api/driver/me", { headers: { cookie: `umx_driver_session=${encodeURIComponent(`${token}x`)}` } });
    assert.equal(await driverSessionFromRequest(tampered), null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
