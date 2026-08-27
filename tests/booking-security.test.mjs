import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

test("only the configured travel date is accepted", async () => {
  const { TRAVEL_DATE, isValidTravelDate, getTrip, formatTime } = await vite.ssrLoadModule("/lib/trips.ts");
  assert.equal(isValidTravelDate(TRAVEL_DATE), true);
  assert.equal(isValidTravelDate("2020-01-01"), false);
  assert.equal(getTrip(999), undefined);
  assert.equal(formatTime("13:00"), "1:00 PM");
  const { activeTripIds, tripIsEnabled, isValidTime } = await vite.ssrLoadModule("/lib/trip-settings.ts");
  assert.deepEqual(activeTripIds("MORNING"), [1]);
  assert.deepEqual(activeTripIds("EVENING"), [2]);
  assert.deepEqual(activeTripIds("BOTH"), [1, 2]);
  assert.equal(tripIsEnabled("MORNING", 2), false);
  assert.equal(isValidTime("23:59"), true);
  assert.equal(isValidTime("25:00"), false);
});

test("payment access cookie is scoped to its payment reference", async () => {
  const { paymentAccessCookie, paymentTokenFromRequest } = await vite.ssrLoadModule("/lib/payment-access.ts");
  const cookie = paymentAccessCookie("payment-a", "secret-token", false).split(";", 1)[0];
  const request = new Request("http://localhost", { headers: { cookie } });
  assert.equal(paymentTokenFromRequest(request, "payment-a"), "secret-token");
  assert.equal(paymentTokenFromRequest(request, "payment-b"), null);
});

test("Turso pipeline SQL errors are thrown", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  globalThis.fetch = async () => Response.json({ results: [{ type: "error", error: { message: "constraint failed" } }] });
  try {
    const { turso } = await vite.ssrLoadModule("/lib/turso.ts");
    await assert.rejects(() => turso("SELECT 1"), /constraint failed/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("admin sessions are signed, allowlisted, and reject tampering", async () => {
  const previousEmails = process.env.ADMIN_EMAILS;
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.ADMIN_SESSION_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  try {
    const { createAdminSession, adminEmailFromRequest } = await vite.ssrLoadModule("/lib/admin-auth.ts");
    const session = await createAdminSession("admin@example.com");
    const request = new Request("http://localhost", { headers: { cookie: `umx_admin_session=${encodeURIComponent(session)}` } });
    assert.equal(await adminEmailFromRequest(request), "admin@example.com");
    const tampered = new Request("http://localhost", { headers: { cookie: `umx_admin_session=${encodeURIComponent(`${session}x`)}` } });
    assert.equal(await adminEmailFromRequest(tampered), null);
  } finally {
    if (previousEmails === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousEmails;
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET; else process.env.ADMIN_SESSION_SECRET = previousSecret;
  }
});

test("bootstrap admin password is available only before a stored credential exists", async () => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const previousPassword = process.env.ADMIN_PASSWORD;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.ADMIN_PASSWORD;
  try {
    const { verifyAdminPassword, adminMustChangePassword } = await vite.ssrLoadModule("/lib/admin-credentials.ts");
    assert.equal(await verifyAdminPassword("admin@example.com", "Admin@12345"), true);
    assert.equal(await verifyAdminPassword("admin@example.com", "wrong-password"), false);
    assert.equal(await adminMustChangePassword("admin@example.com"), true);
  } finally {
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousPassword;
  }
});

test("payment provider can switch to Paystack and validates required secret", async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYMENT_PROVIDER = "PAYSTACK";
  delete process.env.PAYSTACK_SECRET_KEY;
  try {
    const { getPaymentProvider, getPaystackCurrency } = await vite.ssrLoadModule("/lib/paystack.ts");
    assert.equal(getPaymentProvider(), "PAYSTACK");
    assert.throws(() => getPaystackCurrency(), /Paystack is not configured/);
  } finally {
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previousProvider;
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previousSecret;
  }
});
