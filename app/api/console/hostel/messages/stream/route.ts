import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { hostelMessageStream } from "@/lib/hostel-engine/message-stream";
import { authorizeHostHostelBooking } from "@/lib/hostel-engine/resident";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The host's live thread, gated by the same booking-ownership rule as the read. */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-message-stream", { limit: 60, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const reference = url.searchParams.get("reference") || "";
    const host = await resolveHostelHost(account);
    const booking = await authorizeHostHostelBooking(host.landlordId, reference);
    return hostelMessageStream({ bookingId: booking.id, viewer: "HOST", after: url.searchParams.get("after") || "" });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
