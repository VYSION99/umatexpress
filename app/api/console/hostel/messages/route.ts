import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { listHostelMessages, sendHostelMessage } from "@/lib/hostel-engine/messages";
import { authorizeHostHostelBooking } from "@/lib/hostel-engine/resident";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The host's side of a resident thread. The booking reference is the address,
 * and the landlord id on the booking is the gate: a host cannot open a thread
 * for a bed that is not theirs.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing hostel booking reference.", 400);
    const host = await resolveHostelHost(account);
    const booking = await authorizeHostHostelBooking(host.landlordId, reference);
    const messages = await listHostelMessages(booking.id, "HOST");
    return Response.json({ ok: true, booking, messages }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-message-send", { limit: 60, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { reference?: unknown; content?: unknown };
    const host = await resolveHostelHost(account);
    const booking = await authorizeHostHostelBooking(host.landlordId, String(body.reference || ""));
    const message = await sendHostelMessage({
      booking,
      senderType: "HOST",
      senderId: account.email,
      senderName: booking.landlordName || account.name,
      content: body.content,
    });
    return Response.json({ ok: true, message }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
