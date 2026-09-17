import { initializeCampusRideQueue } from "@/lib/campus-engine/rides";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

/**
 * Legacy alias of /api/campus/queue/initialize. It is kept so older campusRide
 * clients keep their `{ ride }` response, but it starts a payment, so the same
 * platform account is required here as on the canonical route.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-student-rides", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { passengerName?: string; phone?: string; email?: string; pickupZoneId?: string; destinationZoneId?: string };
    const student = await requireStudent(request);
    const ride = await initializeCampusRideQueue({
      ...body,
      passengerName: body.passengerName || student.name,
      phone: body.phone || student.phone,
      email: student.email,
      origin: new URL(request.url).origin,
      secure: new URL(request.url).protocol === "https:",
    });
    const cookie = "cookie" in ride ? ride.cookie : "";
    const authorizationUrl = "authorizationUrl" in ride ? ride.authorizationUrl : "";
    return ok({ ride: { ...ride, cookie: undefined } }, { status: authorizationUrl ? 202 : 200, headers: cookie ? { "Set-Cookie": cookie, "Cache-Control": "no-store" } : { "Cache-Control": "no-store" } });
  } catch (error) {
    return fail(error);
  }
}
