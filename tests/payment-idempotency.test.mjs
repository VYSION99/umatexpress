import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const pipelineUrl = (url) => String(url).includes("/v2/pipeline");

function pipeline(sql, { rows = [], cols = [], affected = 0 } = {}) {
  void sql;
  return Response.json({ results: [{ type: "ok", response: { result: { rows, cols, affected_row_count: affected } } }] });
}

function withTurso(overrides = {}) {
  const previous = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  return () => {
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous.token;
    void overrides;
  };
}

test("a webhook event is claimed exactly once", async () => {
  const restore = withTurso();
  const originalFetch = globalThis.fetch;
  let inserts = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (!pipelineUrl(url)) return Response.json({});
    const sql = options && typeof options.body === "string" ? JSON.parse(options.body).requests?.[0]?.stmt?.sql || "" : "";
    if (sql.includes("INSERT INTO payment_events")) {
      inserts += 1;
      return pipeline(sql, { affected: inserts === 1 ? 1 : 0 });
    }
    return pipeline(sql);
  };
  try {
    const { claimPaymentEvent } = await vite.ssrLoadModule("/lib/payment-events.ts");
    assert.equal(await claimPaymentEvent("PAYSTACK", "evt-1", "ref-1"), true);
    assert.equal(await claimPaymentEvent("PAYSTACK", "evt-1", "ref-1"), false);
    assert.equal(inserts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a replayed webhook is acknowledged without settling again", async () => {
  const restore = withTurso();
  const originalFetch = globalThis.fetch;
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  const secret = "sk_test_secret_key_for_webhook_idempotency_tests";
  process.env.PAYSTACK_SECRET_KEY = secret;
  let settlements = 0;

  globalThis.fetch = async (url, options = {}) => {
    if (!pipelineUrl(url)) return Response.json({});
    const sql = options && typeof options.body === "string" ? JSON.parse(options.body).requests?.[0]?.stmt?.sql || "" : "";
    if (sql.includes("INSERT INTO payment_events")) return pipeline(sql, { affected: 0 });
    if (/UPDATE payments SET|UPDATE campus_queue_entries|UPDATE bookings SET/.test(sql)) settlements += 1;
    return pipeline(sql, { affected: 1 });
  };

  try {
    const body = JSON.stringify({ event: "charge.success", data: { id: 987654, reference: "ref-dup", amount: 18358, status: "success" } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");

    const { POST } = await vite.ssrLoadModule("/app/api/payments/webhook/route.ts");
    const response = await POST(new Request("https://example.test/api/payments/webhook", { method: "POST", headers: { "x-paystack-signature": signature }, body }));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.match(String(payload.message || ""), /already processed/);
    assert.equal(settlements, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previousSecret;
    restore();
  }
});

test("reconciliation settles a stale pending campusRide payment", async () => {
  const restore = withTurso();
  const originalFetch = globalThis.fetch;
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  const previousProvider = process.env.PAYMENT_PROVIDER;
  process.env.PAYSTACK_SECRET_KEY = "sk_test_secret_key_for_reconciliation_tests";
  process.env.PAYMENT_PROVIDER = "PAYSTACK";
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    if (!pipelineUrl(url)) {
      return Response.json({ status: true, data: { id: 4242, status: "success", amount: 18358, currency: "GHS" } });
    }
    const sql = options && typeof options.body === "string" ? JSON.parse(options.body).requests?.[0]?.stmt?.sql || "" : "";
    calls.push(sql);
    if (sql.includes("SELECT reference FROM campus_payments")) {
      return pipeline(sql, { rows: [[{ value: "ref-stale" }]], cols: [{ name: "reference" }] });
    }
    if (sql.includes("FROM campus_payments WHERE reference = ? AND provider = 'PAYSTACK'")) {
      return pipeline(sql, { rows: [[{ value: "p1" }, { value: "q1" }, { value: "ref-stale" }, { value: "PAYSTACK" }, { value: 18358 }, { value: "PENDING" }]], cols: [{ name: "id" }, { name: "queue_entry_id" }, { name: "reference" }, { name: "provider" }, { name: "amount" }, { name: "status" }] });
    }
    if (sql.includes("SELECT id FROM campus_rides")) {
      return pipeline(sql, { rows: [[{ value: "ride-1" }]], cols: [{ name: "id" }] });
    }
    return pipeline(sql, { affected: 1 });
  };

  try {
    const { reconcilePendingCampusPayments } = await vite.ssrLoadModule("/lib/campus-engine/reconcile.ts");
    const result = await reconcilePendingCampusPayments();
    assert.equal(result.configured, true);
    assert.equal(result.reconciled, 1);
    assert.ok(calls.some((sql) => sql.includes("UPDATE campus_payments SET status = 'SUCCESSFUL'")));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previousSecret;
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previousProvider;
    restore();
  }
});
