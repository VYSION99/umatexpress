import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { deleteHostelPhoto, listHostelPhotosForLandlord, MAX_HOSTEL_PHOTO_BYTES, storeHostelPhoto, updateHostelPhoto } from "@/lib/hostel-engine/photos";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** The landlord's own gallery, every status included — it is their building. */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const propertyId = new URL(request.url).searchParams.get("propertyId") || undefined;
    return Response.json({ ok: true, photos: await listHostelPhotosForLandlord(host.landlordId, propertyId) }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/**
 * One upload: a file, the property it belongs to, and an optional caption and
 * room. The photo starts PENDING, so a landlord can build a gallery without
 * anything reaching a student before a reviewer has seen it.
 */
export async function POST(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-photo-upload", { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo to upload.", 400);
    if (file.size > MAX_HOSTEL_PHOTO_BYTES) {
      throw new CampusEngineError("VALIDATION_ERROR", `Keep each photo under ${Math.round(MAX_HOSTEL_PHOTO_BYTES / 1024 / 1024)} MB.`, 400);
    }
    const photo = await storeHostelPhoto({
      landlordId: host.landlordId,
      propertyId: String(form.get("propertyId") || ""),
      roomId: String(form.get("roomId") || ""),
      caption: String(form.get("caption") || ""),
      contentType: String(file.type || "").toLowerCase(),
      body: await file.arrayBuffer(),
      actor: account.email,
    });
    return Response.json({ ok: true, photo }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/** Caption edits and the cover choice. */
export async function PATCH(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-photo-edit", { limit: 240, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const body = await request.json() as { photoId?: unknown; caption?: unknown; cover?: unknown };
    const photoId = String(body.photoId || "");
    if (!photoId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo.", 400);
    const photo = await updateHostelPhoto({ landlordId: host.landlordId, photoId, caption: body.caption, cover: body.cover });
    return Response.json({ ok: true, photo }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-photo-edit", { limit: 240, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const photoId = new URL(request.url).searchParams.get("photoId") || "";
    if (!photoId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo to remove.", 400);
    const removed = await deleteHostelPhoto({ landlordId: host.landlordId, photoId, actor: account.email });
    return Response.json({ ok: true, ...removed }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
