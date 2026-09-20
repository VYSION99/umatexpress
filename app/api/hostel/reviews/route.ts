import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { authorizeStudentHostelBooking } from "@/lib/hostel-engine/resident";
import { listPropertyReviews, reviewSummaryForProperty, submitHostelReview } from "@/lib/hostel-engine/reviews";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Reviews for one building. Reading is public — the score is part of what a
 * student browses — but writing one needs a signed-in student whose own paid
 * booking is being reviewed, so a score can never be manufactured.
 */
export async function GET(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-reviews-read", { limit: 180, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const url = new URL(request.url);
    const propertyId = String(url.searchParams.get("propertyId") || "").trim();
    if (!propertyId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a property to read its reviews.", 400);
    const limit = Math.min(Math.max(Math.round(Number(url.searchParams.get("limit")) || 12), 1), 50);
    const [reviews, summary] = await Promise.all([
      listPropertyReviews(propertyId, { limit }),
      reviewSummaryForProperty(propertyId),
    ]);
    return Response.json({ ok: true, summary, reviews }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "hostel-review-write", { limit: 10, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    await requireStudent(request);
    const body = await request.json() as { bookingReference?: unknown; rating?: unknown; title?: unknown; body?: unknown };
    const booking = await authorizeStudentHostelBooking(request, String(body.bookingReference || ""));
    const review = await submitHostelReview({ booking, rating: body.rating, title: body.title, body: body.body });
    return Response.json({ ok: true, review }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
