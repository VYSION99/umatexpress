import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { registerOrganizer } from "@/lib/organizers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Open organizer registration (decision D4). Anyone may apply; the application
 * cannot publish a trip, be bookable or take money until a human approves it,
 * so the gate is the review step rather than the sign-up.
 *
 * No session is required, which makes this the one console endpoint a stranger
 * can reach, so it is rate limited on the caller's address.
 */
export async function POST(request: Request) {
  try {
    // Same bucket as /api/console/applications/organizer, so alternating
    // between the two routes cannot buy extra attempts.
    const limited = await rateLimit(request, "console-apply-organizer", { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as Record<string, unknown>;
    const result = await registerOrganizer(body);
    return Response.json(
      {
        ok: true,
        ...result,
        message: "Application received. An administrator will review it before you can sign in.",
      },
      { status: 202, headers: NO_STORE },
    );
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
