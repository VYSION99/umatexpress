import { logEvent } from "@/lib/observability";
import { fetchPaystackBalance } from "@/lib/paystack";
import { envValue } from "@/lib/runtime-env";

/**
 * What Paystack says can be paid right now.
 *
 * Both products pay out of the same Paystack balance, so the reading lives
 * here rather than in either domain. Paystack settles on its own schedule, so
 * this — not the sum of what has been collected — is the ceiling a release job
 * may spend against. Null when Paystack cannot be reached: a job skips rather
 * than guesses, and an attended send is not gated by it.
 */
export async function paystackPayoutBalance() {
  try {
    const currency = (await envValue("PAYSTACK_CURRENCY")) || "GHS";
    return await fetchPaystackBalance(currency);
  } catch (error) {
    logEvent("warn", "payout_balance_unavailable", { reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}
