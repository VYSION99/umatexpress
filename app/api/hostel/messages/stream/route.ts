import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { hostelMessageStream } from "@/lib/hostel-engine/message-stream";
import { authorizeStudentHostelBooking } from "@/lib/hostel-engine/resident";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The student's live thread. Cookies authorise the stream exactly as they
 * authorise the thread itself, so a reference copied off a ticket reveals
 * nothing here either.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-message-stream", { limit: 60, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const reference = url.searchParams.get("reference") || "";
    const booking = await authorizeStudentHostelBooking(request, reference);
    return hostelMessageStream({ bookingId: booking.id, viewer: "STUDENT", after: url.searchParams.get("after") || "" });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
