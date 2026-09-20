import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { listResidentPlugins, listServiceRequestsForBooking, requestHostelService } from "@/lib/hostel-engine/plugins";
import { authorizeStudentHostelBooking } from "@/lib/hostel-engine/resident";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The services half of the resident page.
 *
 * Reading is scoped to one booking: the plugins the landlord switched on for
 * that property and year, with the price this resident pays, plus the requests
 * they have already made. Asking for a service is the only write, and the
 * engine refuses one until the bed payment is confirmed.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-residency-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing hostel booking reference.", 400);
    const booking = await authorizeStudentHostelBooking(request, reference);
    const [plugins, services] = await Promise.all([
      listResidentPlugins({ landlordId: booking.landlordId, periodId: booking.periodId, propertyId: booking.propertyId }),
      listServiceRequestsForBooking(booking.id),
    ]);
    return Response.json({ ok: true, booking, plugins, services }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-service-request", { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { reference?: unknown; pluginId?: unknown; note?: unknown };
    const booking = await authorizeStudentHostelBooking(request, String(body.reference || ""));
    const service = await requestHostelService({
      booking: {
        id: booking.id,
        landlordId: booking.landlordId,
        periodId: booking.periodId,
        propertyId: booking.propertyId,
        studentEmail: booking.studentEmail,
        studentName: booking.studentName,
        status: booking.status,
      },
      pluginId: String(body.pluginId || ""),
      note: String(body.note || ""),
    });
    return Response.json({ ok: true, service }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
