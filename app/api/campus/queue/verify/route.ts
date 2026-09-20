import { verifyCampusRidePayment } from "@/lib/campus-engine/rides";
import { fail, ok } from "@/lib/campus-engine/responses";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    // Verifying settles a queue entry, and each miss is a Paystack call.
    const limited = await rateLimit(request, "campus-queue-verify-read", { limit: 120, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const reference = new URL(request.url).searchParams.get("reference") || "";
    return ok(await verifyCampusRidePayment(request, reference), { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
