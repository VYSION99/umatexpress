// campusRide smoke test.
//
// Read-only by default: it asserts the live invariants that the robustness
// work established and never writes or moves money.
//
//   node scripts/smoke-campus-ride.mjs                 # live DB invariants
//   node scripts/smoke-campus-ride.mjs --url=https://…  # + HTTP health checks
//
// Exit code is non-zero when any check fails, so it can gate a deploy.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnv() {
  const env = {};
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = { ...readEnv(), ...process.env };
const databaseUrl = String(env.TURSO_DATABASE_URL || "");
const token = String(env.TURSO_AUTH_TOKEN || "");
const baseUrl = (process.argv.find((arg) => arg.startsWith("--url=")) || "").replace("--url=", "").replace(/\/$/, "");

if (!databaseUrl || !token || databaseUrl.includes("your-database")) {
  console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not configured.");
  process.exit(2);
}

const url = databaseUrl.replace("libsql://", "https://").replace(/\/$/, "");

async function query(sql, values = []) {
  const response = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args: values.map((value) => ({ type: typeof value === "number" ? "integer" : "text", value: String(value) })) } },
        { type: "close" },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Turso HTTP ${response.status}`);
  const data = await response.json();
  const first = data.results?.[0];
  if (first?.type === "error" || first?.error) throw new Error(first.error?.message || "Turso statement failed.");
  const result = first?.response?.result || {};
  const columns = (result.cols || []).map((column) => column.name);
  return (result.rows || []).map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index]?.value ?? row[index]])));
}

const ACTIVE = "'PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED'";
const results = [];

async function check(name, sql, values, verdict = (rows) => rows.length === 0) {
  try {
    const rows = await query(sql, values);
    const ok = verdict(rows);
    results.push({ name, ok, detail: ok ? "" : JSON.stringify(rows).slice(0, 200) });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : "query failed" });
  }
}

await check("rides: capacity never negative or over capacity",
  "SELECT id, capacity, available_slots FROM campus_rides WHERE available_slots < 0 OR available_slots > capacity");
await check("rides: active queue never exceeds capacity",
  `SELECT r.id, r.capacity, COUNT(q.id) AS active FROM campus_rides r JOIN campus_queue_entries q ON q.ride_id = r.id AND q.queue_status IN (${ACTIVE}) GROUP BY r.id HAVING COUNT(q.id) > r.capacity`);
await check("queue: no duplicate active positions",
  `SELECT ride_id, queue_position, COUNT(*) AS c FROM campus_queue_entries WHERE queue_status IN (${ACTIVE}) GROUP BY ride_id, queue_position HAVING c > 1`);
await check("queue: monotonic position counter is not behind",
  `SELECT r.id, r.next_queue_position AS next, COALESCE(MAX(q.queue_position),0) AS maxpos FROM campus_rides r LEFT JOIN campus_queue_entries q ON q.ride_id = r.id GROUP BY r.id HAVING r.next_queue_position < COALESCE(MAX(q.queue_position),0) + 1`);
await check("queue: successful payments are reflected on the entry",
  "SELECT p.reference FROM campus_payments p JOIN campus_queue_entries q ON q.id = p.queue_entry_id WHERE p.status = 'SUCCESSFUL' AND q.queue_status = 'WAITING_PAYMENT'");
await check("holds: no expired WAITING_PAYMENT holds still holding a slot",
  "SELECT reference, expires_at FROM campus_queue_entries WHERE queue_status = 'WAITING_PAYMENT' AND expires_at IS NOT NULL AND expires_at <> '' AND expires_at < ?",
  [new Date().toISOString()]);
await check("platform: counter/limit/event/notification tables exist",
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metrics_counters','rate_limit_windows','payment_events','auth_failures','notification_outbox')",
  [], (rows) => rows.length === 5);

if (baseUrl) {
  async function http(name, path, verify) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
      const ok = verify(response);
      results.push({ name, ok, detail: ok ? "" : `HTTP ${response.status}` });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : "request failed" });
    }
  }
  await http("http: /api/campus/zones is reachable", "/api/campus/zones", (response) => response.ok);
  await http("http: /api/campus/rides/nearest is reachable", "/api/campus/rides/nearest", (response) => response.ok);
  await http("http: /api/admin/campus/metrics fails closed without auth", "/api/admin/campus/metrics", (response) => response.status === 401);
  await http("http: /api/payments/verify rejects a missing reference", "/api/payments/verify", (response) => response.status === 400);
  await http("http: /api/campus/queue/status rejects a missing reference", "/api/campus/queue/status", (response) => response.status === 400);
}

for (const { name, ok, detail } of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${baseUrl ? ` against ${baseUrl}` : ""}.`);
process.exit(failed ? 1 : 0);
