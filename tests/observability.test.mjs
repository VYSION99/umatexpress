import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

// Mimics the Turso HTTP pipeline shape (rows as arrays of { value }).
function sqliteExecutor(db) {
  return async (sql, values = []) => {
    const statement = db.prepare(sql);
    const returnsRows = /^\s*(SELECT|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql);
    if (returnsRows) {
      const records = statement.all(...values);
      const names = records.length ? Object.keys(records[0]) : [];
      return {
        cols: names.map((name) => ({ name })),
        rows: records.map((record) => names.map((name) => ({ value: record[name] }))),
        affected_row_count: records.length,
      };
    }
    const info = statement.run(...values);
    return { affected_row_count: Number(info.changes || 0) };
  };
}

function newDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE metrics_counters (
      name TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, day)
    );
  `);
  return db;
}

test("the counter upsert accumulates without losing updates", async () => {
  const { consumeMetric } = await vite.ssrLoadModule("/lib/observability.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);

  assert.equal(await consumeMetric(exec, { name: "queue_claim", day: "2026-01-01" }), 1);
  assert.equal(await consumeMetric(exec, { name: "queue_claim", day: "2026-01-01" }), 2);
  assert.equal(await consumeMetric(exec, { name: "queue_claim", day: "2026-01-01", amount: 3 }), 5);
  // A different day is a separate bucket.
  assert.equal(await consumeMetric(exec, { name: "queue_claim", day: "2026-01-02" }), 1);

  const rows = db.prepare("SELECT day, count FROM metrics_counters WHERE name = 'queue_claim' ORDER BY day").all();
  assert.deepEqual(rows.map((row) => [row.day, row.count]), [["2026-01-01", 5], ["2026-01-02", 1]]);
});

test("requestIdFromRequest prefers x-request-id, sanitises it, and falls back", async () => {
  const { requestIdFromRequest } = await vite.ssrLoadModule("/lib/observability.ts");

  const provided = requestIdFromRequest(new Request("https://example.com", { headers: { "x-request-id": "  abc$%^def  " } }));
  assert.equal(provided, "abcdef");

  const cfRay = requestIdFromRequest(new Request("https://example.com", { headers: { "cf-ray": "9f2c1a3b4c5d6e7f-ACC" } }));
  assert.equal(cfRay, "9f2c1a3b4c5d6e7f-ACC");

  const generated = requestIdFromRequest(new Request("https://example.com"));
  assert.ok(generated.length >= 16);
  assert.notEqual(generated, requestIdFromRequest(new Request("https://example.com")));
});

test("withRequestId preserves status and body and sets the header", async () => {
  const { requestIdFromRequest, withRequestId } = await vite.ssrLoadModule("/lib/observability.ts");
  const response = withRequestId(Response.json({ ok: true, amount: 42 }, { status: 202 }), "trace-1");

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-request-id"), "trace-1");
  assert.deepEqual(await response.json(), { ok: true, amount: 42 });
  assert.equal(requestIdFromRequest(new Request("https://example.com", { headers: { "x-request-id": "trace-1" } })), "trace-1");
});

test("logEvent writes one structured JSON line per level", async () => {
  const { logEvent } = await vite.ssrLoadModule("/lib/observability.ts");
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (line) => lines.push(["log", line]);
  console.warn = (line) => lines.push(["warn", line]);
  console.error = (line) => lines.push(["error", line]);
  try {
    logEvent("info", "queue_claim", { requestId: "abc" });
    logEvent("warn", "metric_failed", { name: "queue_claim" });
    logEvent("error", "webhook_failed", { reference: "ref-1" });
  } finally {
    Object.assign(console, original);
  }

  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(([level]) => level), ["log", "warn", "error"]);
  for (const [, line] of lines) {
    assert.equal(line.includes("\n"), false);
    const parsed = JSON.parse(line);
    assert.ok(parsed.ts);
    assert.ok(parsed.event);
    assert.ok(parsed.level);
  }
  assert.equal(JSON.parse(lines[2][1]).reference, "ref-1");
});

test("incrementMetric degrades quietly when Turso is not configured", async () => {
  const { incrementMetric } = await vite.ssrLoadModule("/lib/observability.ts");
  assert.equal(await incrementMetric("queue_claim"), 0);
});
