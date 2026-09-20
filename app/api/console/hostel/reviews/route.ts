import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { listReviewsForLandlord, listReviewsForStaff, moderateHostelReview, replyToHostelReview } from "@/lib/hostel-engine/reviews";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The reviews desk. A landlord reads and answers the reviews left for their own
 * buildings; staff see every review, including the ones hidden from the public
 * page, and hold the only lever that changes that visibility.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD", "ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-reviews-console", { limit: 180, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (account.role === "LANDLORD") {
      const { landlordId } = await resolveHostelHost(account);
      const reviews = await listReviewsForLandlord(landlordId);
      return Response.json({ ok: true, scope: "LANDLORD", reviews, summary: summarize(reviews) }, { headers: NO_STORE });
    }
    const status = String(new URL(request.url).searchParams.get("status") || "").trim().toUpperCase();
    const reviews = await listReviewsForStaff({ status });
    return Response.json({ ok: true, scope: "STAFF", reviews, summary: summarize(reviews) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD", "ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-review-console-write", { limit: 90, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { reviewId?: unknown; action?: unknown; reply?: unknown; reason?: unknown };
    const action = String(body.action || "REPLY").trim().toUpperCase();
    if (action === "REPLY") {
      if (account.role !== "LANDLORD") throw new CampusEngineError("FORBIDDEN", "Only the hostel answers its own reviews.", 403);
      const { landlordId } = await resolveHostelHost(account);
      const review = await replyToHostelReview({ reviewId: String(body.reviewId || ""), landlordId, reply: body.reply, actor: account.email });
      return Response.json({ ok: true, review }, { headers: NO_STORE });
    }
    if (account.role !== "ADMIN" && account.role !== "MODERATOR") {
      throw new CampusEngineError("FORBIDDEN", "Hiding a review belongs to platform staff.", 403);
    }
    const review = await moderateHostelReview({ reviewId: String(body.reviewId || ""), action, reason: body.reason, actor: account.email });
    return Response.json({ ok: true, review }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

function summarize(reviews: { rating: number; status: string }[]) {
  const published = reviews.filter((review) => review.status === "PUBLISHED");
  const average = published.length ? published.reduce((total, review) => total + Number(review.rating || 0), 0) / published.length : 0;
  return { count: reviews.length, published: published.length, hidden: reviews.length - published.length, average };
}
