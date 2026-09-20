import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { getHostelPhoto, readHostelPhotoObject } from "@/lib/hostel-engine/photos";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One approved photo, straight from the private bucket. Only an approved row is
 * served here, so a landlord cannot publish by uploading; and the key is unique
 * per photo, so the bytes never change under a cached URL.
 */
export async function GET(request: Request, { params }: { params: Promise<{ photoId: string }> }) {
  try {
    const limited = await rateLimit(request, "hostel-photo-read", { limit: 600, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { photoId } = await params;
    const photo = await getHostelPhoto(photoId);
    if (!photo || photo.status !== "APPROVED") {
      return Response.json({ ok: false, code: "NOT_FOUND", error: "That photo was not found." }, { status: 404, headers: NO_STORE });
    }
    const object = await readHostelPhotoObject(photo);
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || photo.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=3600, s-maxage=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
