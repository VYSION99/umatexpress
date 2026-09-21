import { rateLimiterNamespace } from "@/lib/cloudflare-bindings";
import { logEvent } from "@/lib/observability";
import { ensureRateLimitTable, isTursoConfiguredRuntime, turso } from "@/lib/turso";

type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitExecutor = (sql: string, values?: Array<string | number>) => Promise<{
  rows?: unknown[];
  cols?: Array<{ name: string }>;
  affected_row_count?: number;
}>;

function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function firstRecord(result: Awaited<ReturnType<RateLimitExecutor>>) {
  const columns = result?.cols?.map((column) => column.name) ?? [];
  const row = result?.rows?.[0];
  if (!row) return null;
  const values = Array.isArray(row) ? row : [];
  return Object.fromEntries(columns.map((column, index) => [column, (values[index] as { value?: unknown })?.value ?? values[index]]));
}

export function rateLimitWindowKey(windowMs: number, now = Date.now()) {
  return String(Math.floor(now / windowMs));
}

/**
 * Consumes one unit from a durable fixed-window counter.
 *
 * The counter lives in Turso, so unlike an in-memory map it survives cold
 * starts and is shared across Worker isolates. The upsert and the read are a
 * single statement, so concurrent requests cannot both observe a stale count.
 */
export async function consumeRateLimitWindow(exec: RateLimitExecutor, input: {
  scope: string;
  subject: string;
  limit: number;
  windowMs: number;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const windowKey = rateLimitWindowKey(input.windowMs, now);
  const windowEnd = (Math.floor(now / input.windowMs) + 1) * input.windowMs;
  const stamp = new Date(now).toISOString();
  const expiresAt = new Date(windowEnd + input.windowMs).toISOString();

  // Bound storage: clear only this subject's expired windows on the way through.
  await exec(
    "DELETE FROM rate_limit_windows WHERE scope = ? AND subject = ? AND expires_at < ?",
    [input.scope, input.subject, stamp],
  );

  const result = await exec(
    `INSERT INTO rate_limit_windows (scope,subject,window_key,count,expires_at,updated_at)
     VALUES (?,?,?,1,?,?)
     ON CONFLICT(scope,subject,window_key) DO UPDATE SET count = rate_limit_windows.count + 1, updated_at = excluded.updated_at
     RETURNING count`,
    [input.scope, input.subject, windowKey, expiresAt, stamp],
  );

  let count = Number(firstRecord(result)?.count || 0);
  if (!count) {
    // Defensive fallback if the engine ever ignores RETURNING on an upsert.
    const fallback = await exec(
      "SELECT count FROM rate_limit_windows WHERE scope = ? AND subject = ? AND window_key = ? LIMIT 1",
      [input.scope, input.subject, windowKey],
    );
    count = Number(firstRecord(fallback)?.count || 1);
  }

  const allowed = count <= input.limit;
  return { allowed, count, windowKey, retryAfter: allowed ? 0 : Math.max(1, Math.ceil((windowEnd - now) / 1000)) };
}

function pruneBuckets(now: number) {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Counts one request in the Durable Object limiter, or returns null when the
 * binding is absent or unhealthy so the caller falls through to the durable
 * Turso counter. One object per subject means the count is serialised, so two
 * simultaneous requests can never both read the same stale value.
 */
async function consumeDurableRateLimit(scope: string, subject: string, options: RateLimitOptions, now: number) {
  const namespace = await rateLimiterNamespace();
  if (!namespace) return null;
  try {
    const stub = namespace.get(namespace.idFromName(`${scope}:${subject}`));
    const response = await stub.fetch("https://rate-limiter/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: options.limit, windowMs: options.windowMs, now }),
    });
    if (!response.ok) return null;
    const decision = await response.json() as { allowed?: unknown; count?: unknown; retryAfter?: unknown };
    if (typeof decision.allowed !== "boolean") return null;
    return {
      ok: decision.allowed,
      remaining: decision.allowed ? Math.max(0, options.limit - Number(decision.count || 0)) : 0,
      retryAfter: Number(decision.retryAfter || 0),
    };
  } catch (error) {
    // Never fail a request because the limiter is unavailable, but never hide
    // it either: without this line a broken binding would silently look like
    // the fallback limiter working.
    logEvent("warn", "rate_limit_binding_failed", { scope, reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * The counter behind every limiter, keyed by whatever the caller decided the
 * subject is. HTTP routes pass an IP; a Durable Object that already knows who
 * a socket belongs to passes the student id, because one room behind a campus
 * NAT must not spend another student's budget.
 */
export async function rateLimitSubject(scope: string, subject: string, options: RateLimitOptions) {
  const now = Date.now();

  // The limiter is a guard, never a gate: a store that is briefly unavailable
  // must degrade to the in-memory counter below rather than fail the request it
  // was only meant to protect.
  try {
    const durable = await consumeDurableRateLimit(scope, subject, options, now);
    if (durable) return durable;

    if (await isTursoConfiguredRuntime()) {
      await ensureRateLimitTable();
      const result = await consumeRateLimitWindow(turso, { scope, subject, limit: options.limit, windowMs: options.windowMs, now });
      return result.allowed
        ? { ok: true, remaining: Math.max(0, options.limit - result.count), retryAfter: 0 }
        : { ok: false, remaining: 0, retryAfter: result.retryAfter };
    }
  } catch (error) {
    logEvent("warn", "rate_limit_store_failed", { scope, reason: error instanceof Error ? error.message : "unknown" });
  }

  // Local preview fallback: per-isolate only, but better than no limit at all.
  pruneBuckets(now);
  const key = `${scope}:${subject}`;
  const existing = buckets.get(key);
  const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + options.windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);

  if (bucket.count <= options.limit) {
    return { ok: true, remaining: options.limit - bucket.count, retryAfter: 0 };
  }

  return {
    ok: false,
    remaining: 0,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export async function rateLimit(request: Request, scope: string, options: RateLimitOptions) {
  return rateLimitSubject(scope, clientIp(request), options);
}

export function rateLimitResponse(retryAfter: number) {
  return Response.json(
    { error: "Too many requests. Please wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}
