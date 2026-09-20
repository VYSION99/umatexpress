import { activatePluginSubscription, cancelPluginSubscription, getPluginSubscriptionByReference } from "@/lib/hostel-engine/plugins";
import { failHostelBooking, getHostelBookingByReference, settleHostelBooking } from "@/lib/hostel-engine/residency";

/**
 * The webhook's door into the hostel money paths.
 *
 * A student who pays and never returns to the checkout callback still owns their
 * bed: Paystack tells the platform directly, and this routes the payment to
 * whichever hostel record owns the reference. It is deliberately thin — all the
 * work is done by the same idempotent settle functions the return URL calls.
 */
export async function settleHostelWebhookPayment(input: {
  reference: string;
  amount: number;
  transactionId: string;
  source: string;
}) {
  const booking = await getHostelBookingByReference(input.reference);
  if (booking) {
    const result = await settleHostelBooking({ ...input, provider: "PAYSTACK" });
    if (result.handled) return result;
  }
  const subscription = await getPluginSubscriptionByReference(input.reference);
  if (subscription) {
    const result = await activatePluginSubscription({ reference: input.reference, amount: input.amount, source: input.source });
    if (result.handled) return result;
  }
  return { handled: false, reason: "HOSTEL_PAYMENT_NOT_FOUND" as const };
}

/** A failed charge frees the bed now instead of waiting out the hold. */
export async function failHostelWebhookPayment(input: { reference: string; reason: string; transactionId: string }) {
  const booking = await getHostelBookingByReference(input.reference);
  if (booking && booking.status === "PENDING_PAYMENT") {
    await failHostelBooking(input.reference);
    return { handled: true, status: "FAILED" as const };
  }
  const subscription = await getPluginSubscriptionByReference(input.reference);
  if (subscription && subscription.status === "PENDING_PAYMENT") {
    await cancelPluginSubscription(input.reference);
    return { handled: true, status: "FAILED" as const };
  }
  return { handled: false, reason: "HOSTEL_PAYMENT_NOT_FOUND" as const };
}
