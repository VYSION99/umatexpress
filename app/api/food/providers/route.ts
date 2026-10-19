import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listPublicFoodListings } from "@/lib/food/listings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "food-directory-read", { limit: 120, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return Response.json({ providers: await listPublicFoodListings() }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
