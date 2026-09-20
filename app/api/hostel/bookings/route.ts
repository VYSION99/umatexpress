import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { startHostelBooking } from "@/lib/hostel-engine/residency";
import { residentDashboard } from "@/lib/hostel-engine/resident";
import { paymentAccessCookie } from "@/lib/payment-access";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The resident page reads here and checkout starts here. Browsing the catalogue
 * needs no account, but claiming a bed does: the booking is made under the
 * signed-in student's own address, which is what makes the resident page theirs.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-residency-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    return Response.json({ ok: true, ...await residentDashboard(student.email) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-booking-start", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const student = await requireStudent(request);
    const body = await request.json() as { listingId?: unknown; note?: unknown };
    const url = new URL(request.url);
    const result = await startHostelBooking({
      listingId: String(body.listingId || ""),
      student: { email: student.email, name: student.name, phone: student.phone },
      origin: url.origin,
      secure: url.protocol === "https:",
      note: String(body.note || ""),
    });
    return Response.json({
      ok: true,
      reference: result.booking?.reference || "",
      authorizationUrl: result.authorizationUrl,
      holdExpiresAt: result.booking?.holdExpiresAt || "",
      holdMinutes: result.holdMinutes,
      booking: result.booking,
    }, {
      status: 201,
      headers: { ...NO_STORE, "Set-Cookie": paymentAccessCookie(result.booking?.reference || "", result.token, result.secure) },
    });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
