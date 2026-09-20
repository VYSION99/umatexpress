import { CampusEngineError } from "@/lib/campus-engine/errors";
import { logEvent } from "@/lib/observability";

/**
 * A read that fails because the database, the edge or a cold isolate was
 * briefly unavailable is worth asking twice: the same query usually succeeds on
 * the next attempt. A deliberate refusal is not, so a `CampusEngineError` is
 * never retried — it is the answer, not a wobble.
 */
export function isTransientFailure(error: unknown) {
  return !(error instanceof CampusEngineError);
}

/** Runs a read again once when it failed for a reason nobody chose. */
export async function withTransientRetry<T>(
  task: () => Promise<T>,
  options: { attempts?: number; label?: string } = {},
) {
  const attempts = Math.max(1, options.attempts ?? 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientFailure(error)) throw error;
      logEvent("warn", "transient_read_retry", {
        label: options.label || "read",
        attempt,
        reason: error instanceof Error ? error.message : "unknown",
      });
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }
  }
  throw lastError;
}
