import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { listHostelMessages, sendHostelMessage } from "@/lib/hostel-engine/messages";
import { authorizeStudentHostelBooking } from "@/lib/hostel-engine/resident";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** A closed booking keeps its history; it just cannot grow new messages. */
const CLOSED_BOOKING_STATUSES = new Set(["EXPIRED", "CANCELLED"]);

/**
 * One thread per booking, as the chat integration doc scopes it. The payment
 * cookie minted at checkout or the signed-in student is what authorises the
 * read, so a reference copied off a ticket reveals nothing about another
 * student's room.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-residency-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing hostel booking reference.", 400);
    const booking = await authorizeStudentHostelBooking(request, reference);
    const messages = await listHostelMessages(booking.id, "STUDENT");
    return Response.json({ ok: true, reference: booking.reference, messages }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-message-send", { limit: 60, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { reference?: unknown; content?: unknown };
    const booking = await authorizeStudentHostelBooking(request, String(body.reference || ""));
    if (CLOSED_BOOKING_STATUSES.has(booking.status)) {
      throw new CampusEngineError("INVALID_STATE", "That booking is closed, so the thread is read-only.", 409);
    }
    const message = await sendHostelMessage({
      booking,
      senderType: "STUDENT",
      senderId: booking.studentEmail,
      senderName: booking.studentName || booking.studentEmail,
      content: body.content,
    });
    return Response.json({ ok: true, message }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
