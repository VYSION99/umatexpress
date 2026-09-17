import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

// Adapts node:sqlite to the executor shape the durable limiter uses. Responses
// mimic the Turso HTTP pipeline (rows as arrays of { value }).
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
    CREATE TABLE rate_limit_windows (
      scope TEXT NOT NULL,
      subject TEXT NOT NULL,
      window_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, subject, window_key)
    );
  `);
  return db;
}

test("the durable window allows up to the limit and blocks the next request", async () => {
  const { consumeRateLimitWindow } = await vite.ssrLoadModule("/lib/rate-limit.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  const results = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    results.push(await consumeRateLimitWindow(exec, { scope: "driver-auth", subject: "203.0.113.7", limit: 3, windowMs: 60_000, now }));
  }

  assert.deepEqual(results.map((result) => result.allowed), [true, true, true, false]);
  assert.equal(results[2].count, 3);
  assert.ok(results[3].retryAfter > 0);
  assert.equal(results[3].count, 4);
});

test("separate subjects and separate windows are counted independently", async () => {
  const { consumeRateLimitWindow } = await vite.ssrLoadModule("/lib/rate-limit.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  for (let attempt = 0; attempt < 3; attempt++) {
    await consumeRateLimitWindow(exec, { scope: "campus-ai", subject: "ip-a", limit: 2, windowMs: 60_000, now });
  }
  // A blocked subject must not affect a different one.
  const otherSubject = await consumeRateLimitWindow(exec, { scope: "campus-ai", subject: "ip-b", limit: 2, windowMs: 60_000, now });
  assert.equal(otherSubject.allowed, true);

  // The next window starts a fresh counter for the original subject.
  const nextWindow = await consumeRateLimitWindow(exec, { scope: "campus-ai", subject: "ip-a", limit: 2, windowMs: 60_000, now: now + 60_000 });
  assert.equal(nextWindow.allowed, true);
  assert.equal(nextWindow.count, 1);

  const rows = db.prepare("SELECT COUNT(*) AS n FROM rate_limit_windows WHERE scope = ? AND subject = ?").get("campus-ai", "ip-a");
  assert.equal(rows.n, 2);
});
