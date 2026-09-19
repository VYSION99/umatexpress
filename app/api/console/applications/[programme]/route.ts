import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { consoleApplicationById } from "@/lib/console-applications";
import { registerOrganizer } from "@/lib/organizers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The single endpoint every application form posts to. The programme in the
 * path is validated against the registry first, so an unopened service answers
 * 404 rather than half-processing a body, and the switch below is the only
 * place that knows how to write a given application down.
 */
async function submitApplication(programme: string, body: Record<string, unknown>) {
  switch (programme) {
    case "organizer":
      return registerOrganizer(body);
    default:
      throw new CampusEngineError("INVALID_STATE", "This application is not being accepted yet.", 501);
  }
}

export async function POST(request: Request, context: { params: Promise<{ programme: string }> }) {
  try {
    const { programme } = await context.params;
    const application = consoleApplicationById(String(programme || "").toLowerCase());
    if (!application || application.status !== "OPEN") {
      throw new CampusEngineError("NOT_FOUND", "That application is not open.", 404);
    }

    // This is the one console endpoint a stranger can reach, so it is rate
    // limited on the caller's address, per programme.
    const limited = await rateLimit(request, `console-apply-${application.id}`, { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as Record<string, unknown>;
    const result = await submitApplication(application.id, body);
    return Response.json(
      {
        ok: true,
        ...result,
        message: application.activation === "REVIEW"
          ? "Application received. An administrator will review it before you can sign in."
          : "Application received. Sign in to get started; publishing goes live after a review.",
      },
      { status: 202, headers: NO_STORE },
    );
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
