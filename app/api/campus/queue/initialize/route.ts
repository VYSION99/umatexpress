import { initializeCampusRideQueue } from "@/lib/campus-engine/rides";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";
import { requestIdFromRequest } from "@/lib/observability";

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-queue-initialize", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { passengerName?: string; phone?: string; email?: string; pickupZoneId?: string; destinationZoneId?: string; rideId?: string; pickupLatitude?: number; pickupLongitude?: number };
    // Joining a queue starts a payment, so it needs the platform account. Browsing
    // rides, zones and fares stays open to everyone.
    const student = await requireStudent(request);
    const result = await initializeCampusRideQueue({
      ...body,
      passengerName: body.passengerName || student.name,
      phone: body.phone || student.phone,
      // Paystack sends the receipt here, so it is always the account address
      // rather than the placeholder campusRide used to invent from a phone number.
      email: student.email,
      origin: new URL(request.url).origin,
      secure: new URL(request.url).protocol === "https:",
      requestId: requestIdFromRequest(request),
    });
    const cookie = "cookie" in result ? result.cookie : "";
    const authorizationUrl = "authorizationUrl" in result ? result.authorizationUrl : "";
    const headers: HeadersInit = cookie ? { "Set-Cookie": cookie, "Cache-Control": "no-store" } : { "Cache-Control": "no-store" };
    return ok({ queue: { ...result, cookie: undefined } }, { status: authorizationUrl ? 202 : 200, headers }, request);
  } catch (error) {
    return fail(error, request);
  }
}
