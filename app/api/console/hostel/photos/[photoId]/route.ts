import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { getHostelPhoto, readHostelPhotoObject } from "@/lib/hostel-engine/photos";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A preview of one photo, whatever its status: the landlord's own, or any
 * landlord's for the staff deciding it. This is the only way a PENDING photo
 * can be looked at, which is what keeps moderation possible.
 */
export async function GET(request: Request, { params }: { params: Promise<{ photoId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD", "ADMIN", "MODERATOR"]);
    const { photoId } = await params;
    const photo = await getHostelPhoto(photoId);
    if (!photo) throw new CampusEngineError("NOT_FOUND", "That photo was not found.", 404);
    if (account.role === "LANDLORD") {
      const host = await resolveHostelHost(account);
      if (photo.landlordId !== host.landlordId) throw new CampusEngineError("NOT_FOUND", "That photo was not found.", 404);
    }
    const object = await readHostelPhotoObject(photo);
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || photo.contentType || "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
