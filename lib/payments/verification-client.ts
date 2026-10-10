export type VerificationState = "success" | "failed" | "review" | "pending" | "signin" | "unavailable";

export function verificationState(status: unknown, paid: boolean): VerificationState {
  if (["PAID_REVIEW", "PAYMENT_REVIEW", "REVERSAL_REVIEW", "REVERSED"].includes(String(status))) return "review";
  if (status === "FAILED") return "failed";
  return paid ? "success" : "pending";
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Only an explicit provider failure can show the retry-payment screen. */
export async function pollPaymentVerification<T>(url: string, signal: AbortSignal, options: { attempts?: number; intervalMs?: number } = {}): Promise<{ state: VerificationState; ticket?: T; authorized: boolean } | null> {
  const attempts = options.attempts ?? 12;
  let authorized = false;
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 25_000);
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (signal.aborted) return null;
      if ([401, 403].includes(response.status)) return { state: "signin" as const, authorized };
      if ([400, 404].includes(response.status)) return { state: "unavailable" as const, authorized };
      if (response.ok) {
        authorized = true;
        const data = await response.json() as { status?: string; ticket?: T };
        const state = verificationState(data.status, data.status === "SUCCESSFUL" && Boolean(data.ticket));
        if (state !== "pending") return { state, ticket: data.ticket, authorized };
      }
    } catch {
      // Network, JSON and provider timeouts leave the outcome unknown.
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
    if (attempt + 1 < attempts) await pause(options.intervalMs ?? 4_000, signal);
  }
  return signal.aborted ? null : { state: "pending" as const, authorized };
}
