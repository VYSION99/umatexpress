import { imagesBinding } from "@/lib/cloudflare-bindings";
import { withEdgeCache } from "@/lib/edge-cache";
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
    const requestedWidth = Number(new URL(request.url).searchParams.get("width"));
    const width = [160, 320, 640, 960, 1440].includes(requestedWidth) ? requestedWidth : 0;
    // Recheck approval before every cache lookup. Only transformed bytes are
    // cached internally; browsers must revalidate so moderation remains effective.
    const response = await withEdgeCache(request, {
      path: `/api/hostel/photos/${encodeURIComponent(photo.id)}?width=${width}&revision=${encodeURIComponent(photo.reviewedAt)}`,
      maxAge: 86400,
    }, async () => {
      let object = await readHostelPhotoObject(photo);
      const images = width ? await imagesBinding() : undefined;
      if (images && object.body) {
        try {
          const transformed = await images.input(object.body).transform({ width, fit: "scale-down" }).output({ format: "image/webp", quality: 80 });
          const output = transformed.response();
          return new Response(output.body, { headers: { "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff" } });
        } catch {
          // The transform may have consumed the stream. Read a fresh original.
          object = await readHostelPhotoObject(photo);
        }
      }
      return new Response(object.body, { headers: {
        "Content-Type": object.httpMetadata?.contentType || photo.contentType || "image/jpeg",
        "X-Content-Type-Options": "nosniff",
      } });
    });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, max-age=0, must-revalidate");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
