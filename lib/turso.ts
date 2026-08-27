type SqlArg = { type: "text" | "integer"; value: string };
type TursoResult = { rows?: unknown[]; cols?: Array<{ name: string }>; affected_row_count?: number };

export function isTursoConfigured() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  return Boolean(url && token && !url.includes("your-database") && !token.startsWith("replace-with"));
}

function config() {
  const url = process.env.TURSO_DATABASE_URL?.replace("libsql://", "https://").replace(/\/$/, "");
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!isTursoConfigured() || !url || !token) throw new Error("Add valid Turso credentials to .env to enable live data.");
  return { url, token };
}

export async function turso(sql: string, values: Array<string | number> = []) {
  const { url, token } = config();
  const args: SqlArg[] = values.map((value) => ({
    type: typeof value === "number" ? "integer" : "text",
    value: String(value),
  }));
  const response = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }, { type: "close" }] }),
  });
  if (!response.ok) throw new Error("Turso database request failed.");
  const data = await response.json() as { results?: Array<{ type?: string; error?: { message?: string }; response?: { result?: TursoResult } }> };
  const first = data.results?.[0];
  if (!first) throw new Error("Turso returned an empty database response.");
  if (first.type === "error" || first.error) throw new Error(first.error?.message || "Turso database operation failed.");
  if (!first.response?.result) throw new Error("Turso returned an invalid database response.");
  return first.response.result;
}

export function rowsToObjects(result: Awaited<ReturnType<typeof turso>>) {
  const columns = result?.cols?.map((col) => col.name) ?? [];
  return (result?.rows ?? []).map((row) => {
    const values = Array.isArray(row) ? row : [];
    return Object.fromEntries(columns.map((column, index) => [column, (values[index] as { value?: unknown })?.value ?? values[index]]));
  });
}

export async function hasColumn(table: string, column: string) {
  const result = await turso(`PRAGMA table_info(${table})`);
  return rowsToObjects(result).some((row) => String(row.name) === column);
}

export async function ensureBookingsTable() {
  await turso(`CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, passenger_name TEXT NOT NULL,
    email TEXT NOT NULL, phone TEXT NOT NULL, seat INTEGER NOT NULL, trip_id INTEGER NOT NULL,
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

  await turso(`CREATE TABLE IF NOT EXISTS seat_holds (
    id TEXT PRIMARY KEY,
    booking_id TEXT UNIQUE NOT NULL,
    trip_id INTEGER NOT NULL,
    travel_date TEXT NOT NULL,
    seat INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'HELD',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(trip_id, travel_date, seat)
  )`);
}
