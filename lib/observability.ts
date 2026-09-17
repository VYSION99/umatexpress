import { ensureMetricsTable, isTursoConfiguredRuntime, turso } from "@/lib/turso";

export type MetricsExecutor = (sql: string, values?: Array<string | number>) => Promise<{
  rows?: unknown[];
  cols?: Array<{ name: string }>;
  affected_row_count?: number;
}>;

type LogLevel = "info" | "warn" | "error";

/** Correlation id for one request, taken from the platform when present. */
export function requestIdFromRequest(request: Request) {
  const provided = request.headers.get("x-request-id") || request.headers.get("cf-ray") || "";
  const clean = provided.trim().replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 96);
  return clean || crypto.randomUUID();
}

/** Attaches the correlation id to an outgoing response. */
export function withRequestId(response: Response, requestId: string) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Structured single-line log. Callers pass only non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function firstRecord(result: Awaited<ReturnType<MetricsExecutor>>) {
  const columns = result?.cols?.map((column) => column.name) ?? [];
  const row = result?.rows?.[0];
  if (!row) return null;
  const values = Array.isArray(row) ? row : [];
  return Object.fromEntries(columns.map((column, index) => [column, (values[index] as { value?: unknown })?.value ?? values[index]]));
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

let metricsTableReady = false;

/** Creates the counter table at most once per isolate. */
async function ensureMetricsReady() {
  if (metricsTableReady) return;
  await ensureMetricsTable();
  metricsTableReady = true;
}

/**
 * Adds to a per-day counter. The upsert and read are one statement, so
 * concurrent increments never lose an update.
 */
export async function consumeMetric(exec: MetricsExecutor, input: { name: string; day: string; amount?: number }) {
  const amount = Math.max(1, Math.round(input.amount || 1));
  const result = await exec(
    `INSERT INTO metrics_counters (name,day,count,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(name,day) DO UPDATE SET count = metrics_counters.count + ?, updated_at = excluded.updated_at
     RETURNING count`,
    [input.name, input.day, amount, new Date().toISOString(), amount],
  );
  return Number(firstRecord(result)?.count || amount);
}

/**
 * Records a counter. Observability must never break a request, so failures are
 * logged and swallowed.
 */
export async function incrementMetric(name: string, amount = 1) {
  try {
    if (!(await isTursoConfiguredRuntime())) return 0;
    await ensureMetricsReady();
    return await consumeMetric(turso, { name, day: utcDay(), amount });
  } catch (error) {
    logEvent("warn", "metric_failed", { name, reason: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

/** Reads the counters recorded for one day, for admin reporting. */
export async function readMetrics(day = utcDay()) {
  if (!(await isTursoConfiguredRuntime())) return { day, counters: {} as Record<string, number> };
  await ensureMetricsReady();
  const result = await turso("SELECT name, count FROM metrics_counters WHERE day = ? ORDER BY name", [day]);
  const columns = result?.cols?.map((column) => column.name) ?? [];
  const counters: Record<string, number> = {};
  for (const row of result?.rows ?? []) {
    const values = Array.isArray(row) ? row : [];
    const record = Object.fromEntries(columns.map((column, index) => [column, (values[index] as { value?: unknown })?.value ?? values[index]]));
    counters[String(record.name)] = Number(record.count || 0);
  }
  return { day, counters };
}
