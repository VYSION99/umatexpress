import { matchNearestRide } from "@/lib/campus-engine/matching";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-nearest-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const pickupZoneId = url.searchParams.get("pickupZoneId") || "";
    const destinationZoneId = url.searchParams.get("destinationZoneId") || "";
    const pickupLatitude = Number(url.searchParams.get("pickupLatitude"));
    const pickupLongitude = Number(url.searchParams.get("pickupLongitude"));
    const data = await matchNearestRide({
      pickupZoneId,
      destinationZoneId,
      pickupLatitude: Number.isFinite(pickupLatitude) ? pickupLatitude : undefined,
      pickupLongitude: Number.isFinite(pickupLongitude) ? pickupLongitude : undefined,
    });
    return ok({ matches: data.matches });
  } catch (error) {
    return fail(error);
  }
}
