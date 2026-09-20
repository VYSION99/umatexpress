import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { HOSTEL_PHOTO_ACTIONS, listPendingHostelPhotos, reviewHostelPhoto } from "@/lib/hostel-engine/photos";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The photo queue: what landlords uploaded and no student may see yet. */
export async function GET(request: Request) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return Response.json({ ok: true, photos: await listPendingHostelPhotos() }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "hostel-photo-review", { limit: 600, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { photoId?: unknown; action?: unknown; reason?: unknown };
    const action = String(body.action || "").trim().toUpperCase();
    if (!(HOSTEL_PHOTO_ACTIONS as readonly string[]).includes(action)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose approve or reject.", 400);
    }
    const photoId = String(body.photoId || "");
    if (!photoId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo to review.", 400);
    const photo = await reviewHostelPhoto({ photoId, action: action as (typeof HOSTEL_PHOTO_ACTIONS)[number], reason: body.reason, actor: account.email });
    return Response.json({ ok: true, photo }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
