import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listPublicSpaces } from "@/lib/hostel-engine/listings";
import { withEdgeCache } from "@/lib/edge-cache";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { withTransientRetry } from "@/lib/transient";

const NO_STORE = { "Cache-Control": "no-store" };
const READ_LIMIT = 240;

/**
 * What a signed-out visitor may see of the hostel catalogue: approved beds in an
 * open year, with the price a student would pay and nothing about the people
 * behind them. Browsing needs no account; booking will.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limited = await rateLimit(request, "hostel-spaces-read", { limit: READ_LIMIT, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return await withEdgeCache(request, { path: `/api/hostel/spaces${url.search}`, maxAge: 60, staleWhileRevalidate: 600 }, async () => {
      const result = await withTransientRetry(
        () => listPublicSpaces({
          propertyId: url.searchParams.get("propertyId") || undefined,
          periodId: url.searchParams.get("periodId") || undefined,
        }),
        { label: "hostel_spaces" },
      );
      return Response.json({ ok: true, ...result }, { headers: NO_STORE });
    });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
