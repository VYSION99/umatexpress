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

test("a NULL column arrives as null, never as the raw cell object", async () => {
  const { rowsToObjects } = await vite.ssrLoadModule("/lib/turso.ts");
  const result = {
    cols: [{ name: "read_at" }, { name: "created_at" }, { name: "attempts" }],
    rows: [[{ type: "null" }, { type: "text", value: "2026-03-01T00:00:00.000Z" }, { type: "integer", value: 3 }]],
  };
  const [row] = rowsToObjects(result);
  // Turso omits `value` entirely for NULL; treating that as a value would make
  // an unread notification look read and an empty field look filled in.
  assert.equal(row.read_at, null);
  assert.equal(String(row.read_at || ""), "");
  assert.equal(row.created_at, "2026-03-01T00:00:00.000Z");
  assert.equal(row.attempts, 3);
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

test("admin password changes use a Cloudflare-compatible PBKDF2 iteration count", async () => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";

  const originalFetch = globalThis.fetch;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("Admin@12345"), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt.buffer, iterations: 100_000 }, key, 256);
  const hash = Array.from(new Uint8Array(bits)).map((byte) => String.fromCharCode(byte)).join("");

  globalThis.fetch = async (url, options = {}) => {
    const body = options && typeof options.body === "string" ? JSON.parse(options.body) : {};
    const request = body.requests?.[0]?.stmt?.sql || "";
    if (request.includes("SELECT password_hash, password_salt, password_iterations FROM admin_credentials WHERE email = ? LIMIT 1")) {
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [[{ value: btoa(hash) }, { value: btoa(String.fromCharCode(...salt)) }, { value: 100_000 }]], cols: [{ name: "password_hash" }, { name: "password_salt" }, { name: "password_iterations" }] } } }] });
    }
    if (request.includes("INSERT INTO admin_credentials")) {
      assert.equal(body.requests[0].stmt.args[3].value, "100000");
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };

  try {
    const { changeAdminPassword } = await vite.ssrLoadModule("/lib/admin-credentials.ts");
    await changeAdminPassword("admin@example.com", "Admin@12345", "NewPass!2345");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("admin can cancel an active booking and release the seat", async () => {
  const previousEmails = process.env.ADMIN_EMAILS;
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.ADMIN_SESSION_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options && typeof options.body === "string" ? JSON.parse(options.body) : {};
    const request = body.requests?.[0]?.stmt?.sql || "";
    calls.push(request);
    if (String(url).includes("/v2/pipeline")) {
      if (request.includes("PRAGMA table_info(bookings)")) {
        return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [{ name: "name" }] } } }] });
      }
      if (request.includes("SELECT id, reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, departure_time, created_at FROM bookings WHERE reference = ? LIMIT 1")) {
        return Response.json({ results: [{ type: "ok", response: { result: { rows: [[{ value: "booking-1" }, { value: "UMX-123" }, { value: "Ama" }, { value: "ama@example.com" }, { value: "0240000000" }, { value: 6 }, { value: "1" }, { value: "2026-08-28" }, { value: 18358 }, { value: "PENDING" }, { value: "AWAITING_PAYMENT" }, { value: "06:30" }, { value: "2026-08-28T00:00:00.000Z" }]], cols: [{ name: "id" }, { name: "reference" }, { name: "passenger_name" }, { name: "email" }, { name: "phone" }, { name: "seat" }, { name: "trip_id" }, { name: "travel_date" }, { name: "amount" }, { name: "payment_status" }, { name: "booking_status" }, { name: "departure_time" }, { name: "created_at" }] } } }] });
      }
      if (request.includes("DELETE FROM seat_holds WHERE booking_id = ?")) {
        return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
      }
      if (request.includes("UPDATE bookings SET payment_status = 'CANCELLED', booking_status = 'CANCELLED' WHERE reference = ?")) {
        return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
      }
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };
  try {
    const route = await vite.ssrLoadModule("/app/api/admin/bookings/route.ts");
    const session = await vite.ssrLoadModule("/lib/admin-auth.ts");
    const request = new Request("http://localhost/api/admin/bookings", {
      method: "DELETE",
      headers: {
        cookie: `umx_admin_session=${encodeURIComponent(await session.createAdminSession("admin@example.com"))}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reference: "UMX-123" }),
    });
    const response = await route.DELETE(request);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.cancelled, true);
    assert.equal(data.reference, "UMX-123");
    assert.ok(calls.some((sql) => sql.includes("DELETE FROM seat_holds WHERE booking_id = ?")));
    assert.ok(calls.some((sql) => sql.includes("INSERT INTO admin_audit_logs")));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEmails === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previousEmails;
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET; else process.env.ADMIN_SESSION_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("payment provider can switch to Paystack, validates required secret, and calculates Ghana fees", async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  const previousFee = process.env.PAYSTACK_FEE_PERCENT;
  process.env.PAYMENT_PROVIDER = "PAYSTACK";
  delete process.env.PAYSTACK_SECRET_KEY;
  try {
    const { calculatePaystackCharge, getPaymentProvider, getPaystackCurrency } = await vite.ssrLoadModule("/lib/paystack.ts");
    assert.equal(getPaymentProvider(), "PAYSTACK");
    assert.throws(() => getPaystackCurrency(), /Paystack is not configured/);
    process.env.PAYSTACK_FEE_PERCENT = "1.95";
    assert.deepEqual(calculatePaystackCharge(18000), { baseAmount: 18000, feeAmount: 358, totalAmount: 18358, feePercent: 1.95 });
  } finally {
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previousProvider;
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previousSecret;
    if (previousFee === undefined) delete process.env.PAYSTACK_FEE_PERCENT; else process.env.PAYSTACK_FEE_PERCENT = previousFee;
  }
});

test("Cloudflare AI uses a dedicated runtime token", async () => {
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousAiToken = process.env.CLOUDFLARE_AI_TOKEN;
  const previousDeployToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  process.env.CLOUDFLARE_API_TOKEN = "broad-deploy-token";
  delete process.env.CLOUDFLARE_AI_TOKEN;
  try {
    const { isCloudflareAiConfigured } = await vite.ssrLoadModule("/lib/cloudflare-ai.ts");
    assert.equal(await isCloudflareAiConfigured(), false);
    process.env.CLOUDFLARE_AI_TOKEN = "narrow-ai-token";
    assert.equal(await isCloudflareAiConfigured(), true);
  } finally {
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousAiToken === undefined) delete process.env.CLOUDFLARE_AI_TOKEN; else process.env.CLOUDFLARE_AI_TOKEN = previousAiToken;
    if (previousDeployToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previousDeployToken;
  }
});

test("campusRide engine enforces state transitions, pricing, and nearest matching", async () => {
  const { assertRideTransition } = await vite.ssrLoadModule("/lib/campus-engine/state.ts");
  const { quoteCampusFare } = await vite.ssrLoadModule("/lib/campus-engine/pricing.ts");
  const { findNearestCampusRides } = await vite.ssrLoadModule("/lib/campus-matching.ts");
  const { demoCampusZones, demoCampusCorridors, demoCampusRides } = await vite.ssrLoadModule("/lib/campus-ride.ts");

  assert.doesNotThrow(() => assertRideTransition("DRAFT", "SEARCHING"));
  assert.throws(() => assertRideTransition("DRAFT", "COMPLETED"), /Cannot move ride/);

  const quote = quoteCampusFare({ corridor: demoCampusCorridors[0], minutes: 7 });
  assert.equal(quote.currency, "GHS");
  assert.ok(quote.total >= quote.subtotal);
  assert.ok(quote.paystackFee >= 0);

  const matches = findNearestCampusRides({
    zones: demoCampusZones,
    corridors: demoCampusCorridors,
    rides: demoCampusRides,
    pickupZoneId: "main-gate",
    destinationZoneId: "lecture-area",
  });
  assert.equal(matches[0].id, "ride-1");
  assert.equal(matches[0].fare, 500);

  const gpsMatches = findNearestCampusRides({
    zones: demoCampusZones,
    corridors: demoCampusCorridors,
    rides: demoCampusRides,
    pickupZoneId: "main-gate",
    destinationZoneId: "main-campus",
    pickupLatitude: 5.3064,
    pickupLongitude: -1.9972,
  });
  assert.equal(gpsMatches[0].id, "ride-2");
  assert.ok(Number.isFinite(gpsMatches[0].pickupDistanceKm));
});

test("campusRide routing falls back to direct geometry when router is unavailable", async () => {
  const previousFetch = globalThis.fetch;
  const previousRouteUrl = process.env.CAMPUS_ROUTING_BASE_URL;
  process.env.CAMPUS_ROUTING_BASE_URL = "https://router.example.test";
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const { campusRoadRoute } = await vite.ssrLoadModule("/lib/campus-routing.ts");
    const route = await campusRoadRoute({ latitude: 5.3009, longitude: -1.9897 }, { latitude: 5.3033, longitude: -1.9948 });
    assert.equal(route.provider, "direct");
    assert.equal(route.fallback, true);
    assert.equal(route.geometry.type, "LineString");
    assert.equal(route.geometry.coordinates.length, 3);
    assert.ok(route.durationSeconds >= 60);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRouteUrl === undefined) delete process.env.CAMPUS_ROUTING_BASE_URL; else process.env.CAMPUS_ROUTING_BASE_URL = previousRouteUrl;
  }
});

test("campusRide routing can use Google Routes when configured", async () => {
  const previousFetch = globalThis.fetch;
  const previousProvider = process.env.CAMPUS_ROUTING_PROVIDER;
  const previousKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.CAMPUS_ROUTING_PROVIDER = "google";
  process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://routes.googleapis.com/directions/v2:computeRoutes");
    assert.equal(options.headers["X-Goog-Api-Key"], "test-google-key");
    assert.match(options.headers["X-Goog-FieldMask"], /geoJsonLinestring/);
    const body = JSON.parse(options.body);
    assert.equal(body.polylineEncoding, "GEO_JSON_LINESTRING");
    return Response.json({ routes: [{ distanceMeters: 920, duration: "240s", polyline: { geoJsonLinestring: { type: "LineString", coordinates: [[-1.9897, 5.3009], [-1.9948, 5.3033]] } } }] });
  };
  try {
    const { campusRoadRoute } = await vite.ssrLoadModule("/lib/campus-routing.ts");
    const route = await campusRoadRoute({ latitude: 5.3009, longitude: -1.9897 }, { latitude: 5.3033, longitude: -1.9948 });
    assert.equal(route.provider, "google");
    assert.equal(route.fallback, false);
    assert.equal(route.distanceMeters, 920);
    assert.equal(route.durationSeconds, 240);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.CAMPUS_ROUTING_PROVIDER; else process.env.CAMPUS_ROUTING_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  }
});

test("campusRide driver demo auth creates a protected session", async () => {
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.ADMIN_SESSION_SECRET = "driver-test-secret-that-is-longer-than-thirty-two-characters";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    const auth = await vite.ssrLoadModule("/app/api/driver/auth/route.ts");
    const me = await vite.ssrLoadModule("/app/api/driver/me/route.ts");
    const loginResponse = await auth.POST(new Request("http://localhost/api/driver/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "driver1@umatexpress.local", password: "Driver@12345" }),
    }));
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie");
    assert.ok(cookie?.includes("umx_driver_session="));
    const meResponse = await me.GET(new Request("http://localhost/api/driver/me", { headers: { cookie } }));
    assert.equal(meResponse.status, 200);
    const data = await meResponse.json();
    assert.equal(data.ok, true);
    assert.equal(data.driver.id, "drv-1");
  } finally {
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET; else process.env.ADMIN_SESSION_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("driver password verification safely rejects malformed stored credentials", async () => {
  const { verifyPassword, validPasswordRecord } = await vite.ssrLoadModule("/lib/campus-engine/crypto.ts");
  assert.equal(validPasswordRecord("not-base64!", "broken%", 100_000), false);
  assert.equal(await verifyPassword("Driver@12345", "not-base64!", "broken%", 100_000), false);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { hashPassword } = await vite.ssrLoadModule("/lib/campus-engine/crypto.ts");
  const stored = await hashPassword("Driver@12345");
  assert.equal(validPasswordRecord(stored.hash, stored.salt, stored.iterations), true);
  assert.equal(await verifyPassword("Driver@12345", stored.hash, stored.salt, stored.iterations), true);
  assert.equal(salt.length, 16);
});

test("campusRide driver password can be changed and admin reset requires temporary change", async () => {
  const previousSecret = process.env.ADMIN_SESSION_SECRET;
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.ADMIN_SESSION_SECRET = "driver-change-secret-that-is-longer-than-thirty-two-characters";
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const { hashPassword } = await vite.ssrLoadModule("/lib/campus-engine/crypto.ts");
  const current = await hashPassword("Driver@12345");
  const updates = [];

  globalThis.fetch = async (url, options = {}) => {
    const body = options && typeof options.body === "string" ? JSON.parse(options.body) : {};
    const request = body.requests?.[0]?.stmt?.sql || "";
    if (String(url).includes("/v2/pipeline")) {
      if (request.includes("SELECT id FROM campus_drivers WHERE id = ? LIMIT 1")) {
        return Response.json({ results: [{ type: "ok", response: { result: { rows: [[{ value: "drv-1" }]], cols: [{ name: "id" }] } } }] });
      }
      if (request.includes("COALESCE(token_version,0) AS token_version FROM campus_drivers WHERE id = ? AND active = 1 LIMIT 1")) {
        return Response.json({ results: [{ type: "ok", response: { result: { rows: [[{ value: current.hash }, { value: current.salt }, { value: current.iterations }, { value: 0 }]], cols: [{ name: "password_hash" }, { name: "password_salt" }, { name: "password_iterations" }, { name: "token_version" }] } } }] });
      }
      if (request.includes("UPDATE campus_drivers SET password_hash = ?, password_salt = ?, password_iterations = ?, password_reset_required = ?")) {
        updates.push(body.requests[0].stmt.args.map((arg) => arg.value));
      }
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [] } } }] });
  };

  try {
    const auth = await vite.ssrLoadModule("/lib/campus-engine/driver-auth.ts");
    const session = await auth.createDriverSession("drv-1");
    await auth.changeDriverPassword(
      new Request("http://localhost/api/driver/auth", { headers: { cookie: `umx_driver_session=${encodeURIComponent(session)}` } }),
      { currentPassword: "Driver@12345", newPassword: "DriverNew!234" },
    );
    await auth.resetDriverPasswordByAdmin("drv-1");
    assert.equal(updates.some((args) => args[3] === "0"), true);
    assert.equal(updates.some((args) => args[3] === "1"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET; else process.env.ADMIN_SESSION_SECRET = previousSecret;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("admin credential validation safely rejects malformed stored hashes", async () => {
  const { validAdminCredential } = await vite.ssrLoadModule("/lib/admin-credentials.ts");
  assert.equal(validAdminCredential({ password_hash:"bad!", password_salt:"broken%", password_iterations:100_000 }), false);
  assert.equal(validAdminCredential({ password_hash:btoa("x".repeat(32)), password_salt:btoa("s".repeat(16)), password_iterations:100_000 }), true);
});

test("campusRide student queue refuses an unauthenticated booking", async () => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    const route = await vite.ssrLoadModule("/app/api/campus/queue/initialize/route.ts");
    const response = await route.POST(new Request("http://localhost/api/campus/queue/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        passengerName: "Ama Student",
        phone: "0540000000",
        pickupZoneId: "main-gate",
        destinationZoneId: "lecture-area",
      }),
    }));
    // Accounts are stored in the database, so without Turso there is nobody to
    // authorise and the paid queue path stops before any payment provider call.
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("x-request-id"));
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "UNAUTHORIZED");
  } finally {
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("the legacy v1 rides alias refuses an unauthenticated booking too", async () => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    const route = await vite.ssrLoadModule("/app/api/v1/campus/student/rides/route.ts");
    const response = await route.POST(new Request("http://localhost/api/v1/campus/student/rides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passengerName: "Ama Student", phone: "0540000000", pickupZoneId: "main-gate", destinationZoneId: "lecture-area" }),
    }));
    // Both aliases reach the same paid queue, so a visitor without a session is
    // stopped here exactly as on /api/campus/queue/initialize.
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "UNAUTHORIZED");
  } finally {
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

test("campusRide Paystack settlement confirms queue and reserves a slot", async () => {
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const body = options && typeof options.body === "string" ? JSON.parse(options.body) : {};
    const sql = body.requests?.[0]?.stmt?.sql || "";
    calls.push(sql);
    if (!String(url).includes("/v2/pipeline")) return Response.json({});
    if (sql.includes("PRAGMA table_info(campus_queue_entries)")) {
      const names = ["ride_pin", "accepted_at", "arrived_at", "boarded_at", "completed_at", "cancelled_at"];
      return Response.json({ results: [{ type: "ok", response: { result: { rows: names.map((name) => [{ value: 0 }, { value: name }]), cols: [{ name: "cid" }, { name: "name" }] } } }] });
    }
    if (sql.includes("SELECT id,queue_entry_id,reference,provider,amount,status FROM campus_payments")) {
      return Response.json({ results: [{ type: "ok", response: { result: { rows: [[{ value: "payment-1" }, { value: "queue-1" }, { value: "pay-ref-1" }, { value: "PAYSTACK" }, { value: 18358 }, { value: "PENDING" }]], cols: [{ name: "id" }, { name: "queue_entry_id" }, { name: "reference" }, { name: "provider" }, { name: "amount" }, { name: "status" }] } } }] });
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [], affected_row_count: 1 } } }] });
  };

  try {
    const { markCampusRidePaymentSuccessful } = await vite.ssrLoadModule("/lib/campus-engine/rides.ts");
    const result = await markCampusRidePaymentSuccessful("pay-ref-1", 18358, "txn-1");
    assert.equal(result.handled, true);
    assert.equal(result.status, "SUCCESSFUL");
    // Settlement advances the queue entry through a guarded, idempotent transition.
    assert.ok(calls.some((sql) => sql.includes("UPDATE campus_queue_entries SET queue_status = ?") && sql.includes("WHERE id = ? AND queue_status = ?")));
    assert.ok(calls.some((sql) => sql.includes("UPDATE campus_payments SET status = 'SUCCESSFUL'") && sql.includes("AND status <> 'SUCCESSFUL'")));
    // Capacity is reserved at claim time, so settlement must not decrement it again.
    assert.ok(!calls.some((sql) => sql.includes("available_slots = CASE WHEN available_slots > 0 THEN available_slots - 1")));
    assert.ok(calls.some((sql) => sql.includes("INSERT INTO campus_audit_logs")));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});
