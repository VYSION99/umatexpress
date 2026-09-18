import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

test("the binding plan declares every binding by default", async () => {
  const { bindingPlan, wranglerBindingConfig } = await vite.ssrLoadModule("/build/cloudflare-binding-plan.ts");
  const plan = bindingPlan({});
  const config = wranglerBindingConfig(plan);

  assert.deepEqual(config.ai, { binding: "AI" });
  assert.deepEqual(config.images, { binding: "IMAGES" });
  assert.deepEqual(config.r2_buckets, [{ binding: "PRIVATE_BUCKET", bucket_name: "umatexpress-private" }]);
  assert.deepEqual(config.queues.producers, [{ binding: "NOTIFICATION_QUEUE", queue: "umatexpress-notifications" }]);
  assert.equal(config.queues.consumers[0].queue, "umatexpress-notifications");
  assert.equal(config.queues.consumers[0].dead_letter_queue, "umatexpress-notifications-dlq");
  assert.deepEqual(config.durable_objects.bindings, [{ name: "RATE_LIMITER", class_name: "RateLimiter" }]);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["RateLimiter"] }]);
  assert.deepEqual(config.services, []);
  assert.deepEqual(config.mtls_certificates, []);
  // The free plan rejects any explicit limit, so the default sends none and
  // each job is sized to fit inside fifty subrequests instead.
  assert.deepEqual(config.limits, {});
  assert.equal(config.queues.consumers[0].max_batch_size, 10);

  // The effective names are mirrored into vars so the Worker resolves exactly
  // what was deployed, even after a rename or a binding being switched off.
  assert.equal(config.vars.CLOUDFLARE_AI_BINDING, "AI");
  assert.equal(config.vars.CLOUDFLARE_R2_BUCKET, "umatexpress-private");
  assert.equal(config.vars.CLOUDFLARE_QUEUE, "umatexpress-notifications");
});

test("an empty value disables a binding and a value renames it", async () => {
  const { bindingPlan, wranglerBindingConfig } = await vite.ssrLoadModule("/build/cloudflare-binding-plan.ts");
  const plan = bindingPlan({
    CLOUDFLARE_AI_BINDING: "",
    CLOUDFLARE_IMAGES_BINDING: "IMAGE_KIT",
    CLOUDFLARE_RATE_LIMITER_BINDING: "",
    CLOUDFLARE_R2_BUCKET: "",
    CLOUDFLARE_QUEUE: "",
    CLOUDFLARE_MTLS_CERTIFICATES: "MTN_MOMO_CERT=abc-123",
    CLOUDFLARE_SERVICE_BINDINGS: "CONSOLE=umatexpress-console",
  });
  const config = wranglerBindingConfig(plan);

  assert.equal(config.ai, undefined);
  assert.deepEqual(config.images, { binding: "IMAGE_KIT" });
  assert.deepEqual(config.r2_buckets, []);
  assert.deepEqual(config.queues, { producers: [], consumers: [] });
  assert.deepEqual(config.durable_objects.bindings, []);
  // An empty migration list keeps a deployment that never used the Durable
  // Object from declaring one it does not ship.
  assert.deepEqual(config.migrations, []);
  assert.deepEqual(config.services, [{ binding: "CONSOLE", service: "umatexpress-console" }]);
  assert.deepEqual(config.mtls_certificates, [{ binding: "MTN_MOMO_CERT", certificate_id: "abc-123" }]);
  assert.equal(config.vars.CLOUDFLARE_AI_BINDING, "");
  assert.equal(plan.vars.CLOUDFLARE_MTLS_CERTIFICATES, "MTN_MOMO_CERT=abc-123");
});

test("an empty subrequest limit leaves the plan default alone", async () => {
  const { bindingPlan, wranglerBindingConfig } = await vite.ssrLoadModule("/build/cloudflare-binding-plan.ts");
  assert.deepEqual(wranglerBindingConfig(bindingPlan({ CLOUDFLARE_SUBREQUEST_LIMIT: "" })).limits, {});
  assert.deepEqual(wranglerBindingConfig(bindingPlan({ CLOUDFLARE_SUBREQUEST_LIMIT: "250" })).limits, { subrequests: 250 });
  assert.deepEqual(wranglerBindingConfig(bindingPlan({ CLOUDFLARE_SUBREQUEST_LIMIT: "not-a-number" })).limits, {});
});

test("each cron trigger names one job", async () => {
  const { WORKER_CRONS, CAMPUS_RECONCILE_CRON, NOTIFICATION_SWEEP_CRON } = await vite.ssrLoadModule("/lib/campus-engine/crons.ts");
  assert.deepEqual(WORKER_CRONS, [CAMPUS_RECONCILE_CRON, NOTIFICATION_SWEEP_CRON]);
  assert.notEqual(CAMPUS_RECONCILE_CRON, NOTIFICATION_SWEEP_CRON);
  assert.match(CAMPUS_RECONCILE_CRON, /^\*\/\d+ /);

  // Cloudflare collapses triggers that fall due in the same minute into a
  // single invocation, so a shared minute silently deletes a job. This caught
  // a quarter-hourly sweep that never ran because every :00, :15, :30 and :45
  // already belonged to the five-minute reconcile.
  const minutes = (expression) => {
    const field = expression.split(" ")[0];
    if (field === "*") return Array.from({ length: 60 }, (_, minute) => minute);
    if (field.startsWith("*/")) return Array.from({ length: 60 }, (_, minute) => minute).filter((minute) => minute % Number(field.slice(2)) === 0);
    return field.split(",").map(Number);
  };
  const shared = minutes(CAMPUS_RECONCILE_CRON).filter((minute) => minutes(NOTIFICATION_SWEEP_CRON).includes(minute));
  assert.deepEqual(shared, []);
});

test("malformed binding lists are dropped instead of half-configured", async () => {
  const { parseBindingPairs } = await vite.ssrLoadModule("/lib/cloudflare-binding-spec.ts");
  assert.deepEqual(parseBindingPairs(" A = b , broken , =x , A=c , B=d , "), [
    { binding: "A", value: "b" },
    { binding: "B", value: "d" },
  ]);
  assert.deepEqual(parseBindingPairs(undefined), []);
  assert.deepEqual(parseBindingPairs("lowercase=value"), []);
});

function fakeStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get alarm() { return alarm; },
    async getAlarm() { return alarm; },
    async setAlarm(scheduledTime) { alarm = scheduledTime; },
    async deleteAll() { map.clear(); alarm = null; },
    async transaction(closure) {
      return closure({
        async get(key) { return map.get(key); },
        async put(key, value) { map.set(key, value); },
      });
    },
  };
}

test("the Durable Object limiter allows the limit and blocks the next request", async () => {
  const { RateLimiter } = await vite.ssrLoadModule("/worker/rate-limiter.ts");
  const storage = fakeStorage();
  const limiter = new RateLimiter({ storage });
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  const decisions = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    decisions.push(await limiter.consume({ limit: 3, windowMs: 60_000, now }));
  }

  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, true, false]);
  assert.equal(decisions[2].count, 3);
  assert.equal(decisions[3].count, 4);
  assert.ok(decisions[3].retryAfter > 0);
  // The window is armed once, at the moment it ends.
  assert.equal(storage.alarm, now + 60_000);

  // A new window starts a fresh count for the same subject.
  const nextWindow = await limiter.consume({ limit: 3, windowMs: 60_000, now: now + 60_000 });
  assert.equal(nextWindow.allowed, true);
  assert.equal(nextWindow.count, 1);

  await limiter.alarm();
  assert.equal(storage.map.size, 0);
  assert.equal(storage.alarm, null);
});

test("the Durable Object limiter answers the wire protocol and rejects bad requests", async () => {
  const { RateLimiter } = await vite.ssrLoadModule("/worker/rate-limiter.ts");
  const limiter = new RateLimiter({ storage: fakeStorage() });

  const response = await limiter.fetch(new Request("https://rate-limiter/consume", {
    method: "POST",
    body: JSON.stringify({ limit: 1, windowMs: 60_000, now: Date.UTC(2026, 0, 1) }),
  }));
  assert.equal(response.status, 200);
  const decision = await response.json();
  assert.equal(decision.allowed, true);

  const second = await limiter.fetch(new Request("https://rate-limiter/consume", { method: "POST", body: JSON.stringify({ limit: 1, windowMs: 60_000, now: Date.UTC(2026, 0, 1) }) }));
  assert.equal((await second.json()).allowed, false);

  assert.equal((await limiter.fetch(new Request("https://rate-limiter/other"))).status, 404);
  assert.equal((await limiter.fetch(new Request("https://rate-limiter/consume"))).status, 405);
});

test("the bindings report is safe to call where no binding exists", async () => {
  const { cloudflareBindingReports } = await vite.ssrLoadModule("/lib/cloudflare-bindings.ts");
  const report = await cloudflareBindingReports();

  assert.equal(report.runtime, "node");
  assert.deepEqual(report.bindings.map((entry) => entry.kind), ["ai", "images", "r2", "queue", "durable-object"]);
  assert.ok(report.bindings.every((entry) => entry.present === false));
  assert.equal(report.bindings.find((entry) => entry.kind === "r2").resource, "umatexpress-private");
});

test("a queue-driven dispatch delivers only the rows it was given", async () => {
  const previous = {
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN,
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
  };
  process.env.TURSO_DATABASE_URL = "libsql://example.test";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "UMaTeXPRESS <rides@example.test>";
  const originalFetch = globalThis.fetch;
  const statements = [];
  const recipients = [];
  const tursoResult = (names, rows) => ({
    results: [{ type: "ok", response: { result: { cols: names.map((name) => ({ name })), rows: rows.map((row) => row.map((value) => ({ value }))) } } }],
  });

  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      recipients.push(JSON.parse(String(init?.body)).to[0]);
      return Response.json({ id: "email-1" });
    }
    const { sql, args } = JSON.parse(String(init?.body)).requests[0].stmt;
    statements.push({ sql, args: (args || []).map((arg) => arg.value) });
    if (sql.includes("SELECT id,recipient,subject,template,message,reference")) {
      return Response.json(tursoResult(
        ["id", "recipient", "subject", "template", "message", "reference"],
        [["n-1", "ama@st.umat.edu.gh", "Driver accepted", "driver_accepted", "Driver accepted you.", "CR-1"]],
      ));
    }
    return Response.json({ results: [{ type: "ok", response: { result: { rows: [], cols: [], affected_row_count: 1 } } }] });
  };

  try {
    const { dispatchPendingNotifications } = await vite.ssrLoadModule("/lib/notifications.ts");
    const result = await dispatchPendingNotifications({ ids: ["n-1"] });

    assert.equal(result.sent, 1);
    assert.deepEqual(recipients, ["ama@st.umat.edu.gh"]);
    const select = statements.find((entry) => entry.sql.includes("SELECT id,recipient,subject,template,message,reference"));
    assert.match(select.sql, /AND id IN \(\?\)/);
    assert.ok(select.args.includes("n-1"));
    // Retention pruning belongs to the cron sweep, not to every queue message.
    assert.equal(statements.some((entry) => entry.sql.startsWith("DELETE FROM notification_outbox")), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["TURSO_DATABASE_URL", previous.url], ["TURSO_AUTH_TOKEN", previous.token], ["RESEND_API_KEY", previous.key], ["RESEND_FROM", previous.from]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("the built Worker exports the Durable Object class the migration names", async () => {
  const entry = readFileSync(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(entry, /RateLimiter/);
});
