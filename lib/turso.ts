import { envValue } from "@/lib/runtime-env";

type SqlArg = { type: "text" | "integer" | "null"; value?: string };
type TursoResult = { rows?: unknown[]; cols?: Array<{ name: string }>; affected_row_count?: number };
type TursoStep = { error?: { message?: string }; response?: { result?: TursoResult } };

async function pipeline(requests: Array<Record<string, unknown>>) {
  const { url, token } = await config();
  const response = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
  });
  if (!response.ok) throw new Error("Turso database request failed.");
  const data = await response.json() as { results?: TursoStep[] };
  return data.results ?? [];
}

function stepResult(step: TursoStep | undefined) {
  if (!step) throw new Error("Turso returned an empty database response.");
  if (step.error) throw new Error(step.error.message || "Turso database operation failed.");
  if (!step.response?.result) throw new Error("Turso returned an invalid database response.");
  return step.response.result;
}

export function isTursoConfigured() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  return Boolean(url && token && !url.includes("your-database") && !token.startsWith("replace-with"));
}

export async function isTursoConfiguredRuntime() {
  const url = await envValue("TURSO_DATABASE_URL");
  const token = await envValue("TURSO_AUTH_TOKEN");
  return Boolean(url && token && !url.includes("your-database") && !token.startsWith("replace-with"));
}

async function config() {
  const rawUrl = await envValue("TURSO_DATABASE_URL");
  const url = rawUrl.replace("libsql://", "https://").replace(/\/$/, "");
  const token = await envValue("TURSO_AUTH_TOKEN");
  if (!await isTursoConfiguredRuntime() || !url || !token) throw new Error("Add valid Turso credentials to .env to enable live data.");
  return { url, token };
}

export async function turso(sql: string, values: Array<string | number | null> = []) {
  // Turso sends SQL NULL as a tagged cell with no value at all; sending the
  // string "null" instead would store four characters and read back as filled.
  const args: SqlArg[] = values.map((value) => (value === null
    ? { type: "null" as const }
    : { type: typeof value === "number" ? "integer" as const : "text" as const, value: String(value) }));
  const [first] = await pipeline([{ type: "execute", stmt: { sql, args } }]);
  return stepResult(first);
}

/**
 * Sends many statements in one pipeline request. Turso bills and counts one
 * subrequest per HTTP call, not per statement, so a schema pass that used to
 * cost dozens of round trips now costs one. Every statement still runs and
 * failures are reported per statement rather than aborting the batch, which is
 * what lets a `duplicate column name` on an existing database be tolerated.
 */
export async function tursoBatch(statements: string[]) {
  if (!statements.length) return [];
  const steps = await pipeline(statements.map((sql) => ({ type: "execute", stmt: { sql, args: [] as SqlArg[] } })));
  return statements.map((_sql, index) => steps[index]);
}

/**
 * Applies an idempotent schema pass at most once per version, across isolates.
 * A cold isolate reads one marker row and stops, so the pass costs a single
 * subrequest instead of one per statement.
 *
 * `statements` must survive being run against a database that already has some
 * of them applied. `CREATE TABLE/INDEX IF NOT EXISTS` does; `ALTER TABLE ADD
 * COLUMN` does not, so its `duplicate column name` reply is tolerated rather
 * than probing every column with a query of its own.
 *
 * The marker is written only after every statement has landed, so a partial
 * pass is retried by the next caller instead of being trusted as complete.
 */
export async function runSchemaPass(input: {
  id: string;
  version: string;
  statements: string[];
  metaTable?: string;
  tolerate?: RegExp;
}) {
  const metaTable = input.metaTable || "schema_passes";
  const tolerate = input.tolerate ?? /duplicate column name/i;
  const [createMarker, readMarker] = await tursoBatch([
    `CREATE TABLE IF NOT EXISTS ${metaTable} (id TEXT PRIMARY KEY,version TEXT NOT NULL,applied_at TEXT NOT NULL)`,
    `SELECT version FROM ${metaTable} WHERE id = '${input.id}'`,
  ]);
  const probeFailure = [createMarker, readMarker].find((step) => step?.error);
  if (probeFailure) throw new Error(probeFailure.error?.message || "Could not read the schema marker.");
  const applied = rowsToObjects(readMarker?.response?.result ?? {})[0]?.version;
  if (String(applied ?? "") === input.version) return;

  const steps = await tursoBatch(input.statements);
  const failed = steps
    .map((step) => step?.error?.message)
    .filter((message) => message && !tolerate.test(String(message)));
  if (failed.length) throw new Error(String(failed[0]));

  await tursoBatch([
    `INSERT OR REPLACE INTO ${metaTable} (id,version,applied_at) VALUES ('${input.id}','${input.version}','${new Date().toISOString()}')`,
  ]);
}

export function rowsToObjects(result: Awaited<ReturnType<typeof turso>>) {
  const columns = result?.cols?.map((col) => col.name) ?? [];
  return (result?.rows ?? []).map((row) => {
    const values = Array.isArray(row) ? row : [];
    return Object.fromEntries(columns.map((column, index) => [column, cellValue(values[index])]));
  });
}

/**
 * Turso sends every cell as `{ type, value }`, and sends SQL NULL as
 * `{ type: "null" }` with no value at all. Unwrapping that shape by its `value`
 * alone would hand callers the cell object itself for a NULL column, which then
 * reads as the truthy string "[object Object]" — an empty string that looked
 * filled in, or a `read_at` that looked set on an unread row.
 */
function cellValue(cell: unknown) {
  if (cell && typeof cell === "object") {
    if ("value" in cell) return (cell as { value?: unknown }).value ?? null;
    if ("type" in cell) return null;
  }
  return cell;
}

export async function hasColumn(table: string, column: string) {
  const result = await turso(`PRAGMA table_info(${table})`);
  return rowsToObjects(result).some((row) => String(row.name) === column);
}

export async function ensureBookingsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, passenger_name TEXT NOT NULL,
    email TEXT NOT NULL, phone TEXT NOT NULL, seat INTEGER NOT NULL, trip_id TEXT NOT NULL,
    travel_date TEXT NOT NULL, amount INTEGER NOT NULL, payment_status TEXT NOT NULL DEFAULT 'PENDING',
    booking_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT', hold_expires_at TEXT,
    confirmed_at TEXT, departure_time TEXT, created_at TEXT NOT NULL
  )`);

  if (!(await hasColumn("bookings", "booking_status"))) {
    await turso("ALTER TABLE bookings ADD COLUMN booking_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT'");
  }
  if (!(await hasColumn("bookings", "hold_expires_at"))) {
    await turso("ALTER TABLE bookings ADD COLUMN hold_expires_at TEXT");
  }
  if (!(await hasColumn("bookings", "confirmed_at"))) {
    await turso("ALTER TABLE bookings ADD COLUMN confirmed_at TEXT");
  }
  if (false === await hasColumn("bookings", "departure_time")) {
    await turso("ALTER TABLE bookings ADD COLUMN departure_time TEXT");
  }
}

export async function ensurePaymentsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    reference_id TEXT UNIQUE NOT NULL,
    external_id TEXT NOT NULL,
    financial_transaction_id TEXT,
    payer_phone TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);

  if (!(await hasColumn("payments", "access_token_hash"))) {
    await turso("ALTER TABLE payments ADD COLUMN access_token_hash TEXT");
  }
  if (!(await hasColumn("payments", "fare_amount"))) {
    await turso("ALTER TABLE payments ADD COLUMN fare_amount INTEGER NOT NULL DEFAULT 0");
  }
  if (!(await hasColumn("payments", "fee_amount"))) {
    await turso("ALTER TABLE payments ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0");
  }

  await turso(`CREATE TABLE IF NOT EXISTS seat_holds (
    id TEXT PRIMARY KEY,
    booking_id TEXT UNIQUE NOT NULL,
    trip_id TEXT NOT NULL,
    travel_date TEXT NOT NULL,
    seat INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'HELD',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(trip_id, travel_date, seat)
  )`);
}

export async function ensurePaymentEventsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS payment_events (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    reference TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (provider, event_id)
  )`);
}

export async function ensureMetricsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS metrics_counters (
    name TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (name, day)
  )`);
}

export async function ensureRateLimitTable() {
  await turso(`CREATE TABLE IF NOT EXISTS rate_limit_windows (
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    window_key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, subject, window_key)
  )`);
}

export async function ensureAuthFailuresTable() {
  await turso(`CREATE TABLE IF NOT EXISTS auth_failures (
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, subject)
  )`);
}

let notificationsTableReady: Promise<void> | null = null;

/**
 * Creates and self-heals the notification outbox once per isolate. The check is
 * several statements against a hosted database, and the in-app feed reads this
 * table on every home-screen load, so repeating it would be paid by the student.
 * A failure is forgotten rather than cached.
 */
export function ensureNotificationsTable() {
  if (!notificationsTableReady) {
    notificationsTableReady = createNotificationsTable().catch((error: unknown) => {
      notificationsTableReady = null;
      throw error;
    });
  }
  return notificationsTableReady;
}

async function createNotificationsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    template TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    available_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    read_at TEXT
  )`);
  if (!(await hasColumn("notification_outbox", "subject"))) {
    await turso("ALTER TABLE notification_outbox ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
  }
  if (!(await hasColumn("notification_outbox", "read_at"))) {
    await turso("ALTER TABLE notification_outbox ADD COLUMN read_at TEXT");
  }
  await turso("CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dedupe ON notification_outbox(reference, template)");
  await turso("CREATE INDEX IF NOT EXISTS idx_notification_due ON notification_outbox(status, available_at)");
  await turso("CREATE INDEX IF NOT EXISTS idx_notification_recipient ON notification_outbox(recipient, created_at)");
}

export async function ensureAdminAuditLogTable() {
  await turso(`CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id TEXT PRIMARY KEY,
    admin_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_reference TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
}
