import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { authorizeStudentHostelBooking } from "@/lib/hostel-engine/resident";
import { hostelRefundQuote, listHostelRefundsForStudent, openRefundForBooking, requestHostelRefund } from "@/lib/hostel-engine/refunds";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Cancelling a bed.
 *
 * Reading prices the cancellation by the policy and lists every refund the
 * student already asked for. Writing records the request; the money itself
 * moves only after a platform administrator approves it, so a student cannot
 * drain a booking by refreshing a page.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-refunds-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const reference = String(new URL(request.url).searchParams.get("reference") || "").trim();
    const refunds = await listHostelRefundsForStudent(student.email);
    if (!reference) return Response.json({ ok: true, refunds }, { headers: NO_STORE });
    const booking = await authorizeStudentHostelBooking(request, reference);
    const open = booking ? await openRefundForBooking(booking.id) : null;
    return Response.json({
      ok: true,
      refunds,
      quote: hostelRefundQuote(booking),
      openRefund: open,
      booking: { reference: booking.reference, status: booking.status, totalAmount: booking.totalAmount, periodStartsOn: booking.periodStartsOn },
    }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-refund-request", { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const body = await request.json() as { reference?: unknown; reason?: unknown };
    const booking = await authorizeStudentHostelBooking(request, String(body.reference || ""));
    const refund = await requestHostelRefund({ booking, reason: body.reason, actor: student.email });
    return Response.json({ ok: true, refund }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
