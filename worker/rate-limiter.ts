/**
 * Durable Object rate limiter.
 *
 * One object per (scope, subject) pair, which makes the counter serialisable
 * without any cross-request coordination: a request that arrives while another
 * is being counted waits for the transaction instead of racing it. The window
 * is a fixed window, the same arithmetic the Turso limiter uses, so switching
 * between the two never changes how a limit is measured.
 *
 * The class deliberately avoids `cloudflare:workers` imports so it can be
 * unit-tested with a plain in-memory storage double.
 */

const BUCKET_KEY = "window";
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 24 * 60 * 60_000;

type Bucket = { count: number; resetAt: number };

export type RateLimiterTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export type RateLimiterStorage = {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAll(): Promise<void>;
  transaction<T>(closure: (txn: RateLimiterTransaction) => Promise<T>): Promise<T>;
};

export type RateLimiterState = { storage: RateLimiterStorage };

export type RateLimitDecision = { allowed: boolean; count: number; resetAt: number; retryAfter: number };

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export class RateLimiter {
  constructor(private readonly state: RateLimiterState) {}

  async consume(input: { limit: unknown; windowMs: unknown; now?: number }): Promise<RateLimitDecision> {
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const limit = clamp(input.limit, 1, 1_000_000, 60);
    const windowMs = clamp(input.windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS, 60_000);
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;

    const bucket = await this.state.storage.transaction(async (txn) => {
      const stored = await txn.get<Bucket>(BUCKET_KEY);
      const current: Bucket = stored && stored.resetAt > now ? stored : { count: 0, resetAt };
      current.count += 1;
      await txn.put(BUCKET_KEY, current);
      return current;
    });

    // Exactly one alarm, armed for the moment this window ends. Re-arming on a
    // changed resetAt keeps a stale alarm from clearing a fresh window early.
    const alarm = await this.state.storage.getAlarm();
    if (alarm !== bucket.resetAt) await this.state.storage.setAlarm(bucket.resetAt);

    const allowed = bucket.count <= limit;
    return {
      allowed,
      count: bucket.count,
      resetAt: bucket.resetAt,
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /** The window is over: the counter key is dropped so it cannot accumulate. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/consume") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let body: { limit?: unknown; windowMs?: unknown; now?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const decision = await this.consume({ limit: body.limit, windowMs: body.windowMs, now: Number(body.now) || undefined });
    return Response.json(decision, { headers: { "Cache-Control": "no-store" } });
  }
}
