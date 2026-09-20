import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { expireHostelBooking, failHostelBooking, settleHostelBooking } from "@/lib/hostel-engine/residency";
import { authorizeStudentHostelBooking } from "@/lib/hostel-engine/resident";
import { verifyPaystackTransaction } from "@/lib/paystack";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Where Paystack drops the student back. Authorised by the payment cookie or by
 * the account that made the booking, so a shared link cannot reveal another
 * student's room. Settlement itself is idempotent and shared with the webhook.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-booking-verify", { limit: 120, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing hostel booking reference.", 400);
    let booking = await authorizeStudentHostelBooking(request, reference);
    if (booking.status === "PENDING_PAYMENT") {
      // The provider is asked first, even after the hold ran out: a student who
      // paid late must never lose the bed to a clock.
      const payment = await verifyPaystackTransaction(reference);
      if (payment.status === "SUCCESSFUL") {
        await settleHostelBooking({ reference, amount: payment.amount, transactionId: payment.financialTransactionId, provider: "PAYSTACK", source: "verify" });
      } else if (payment.status === "FAILED") {
        await failHostelBooking(reference);
      } else if (booking.holdExpiresAt && booking.holdExpiresAt < new Date().toISOString()) {
        // Paystack was reached and the checkout is unpaid, so the bed goes back.
        await expireHostelBooking(reference);
      }
      booking = await authorizeStudentHostelBooking(request, reference);
    }
    return Response.json({ ok: true, booking }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
