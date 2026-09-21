import { fail } from "@/lib/campus-engine/responses";
import { cinemaUploadForToken, parseCinemaByteRange, readCinemaMediaObject, verifyCinemaMediaToken } from "@/lib/cinema-engine/media";

/**
 * The bytes behind a signed lease.
 *
 * A video element scrubs by asking for byte ranges, so this route speaks
 * ranges: `Range` in, `206` and `Content-Range` out, and the whole object when
 * no range is asked for. The object key never appears here; the token names the
 * room, the upload and the student, and the row decides whether it is still
 * true. Nothing is cached, because a lease that expires should not survive in a
 * browser's disk cache after the retention job has taken the object away.
 */
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const claims = await verifyCinemaMediaToken((await context.params).token);
    if (!claims) return Response.json({ error: "This video link has expired. Ask the room for a fresh one." }, { status: 401, headers: NO_STORE });
    const upload = await cinemaUploadForToken(claims);
    const range = parseCinemaByteRange(request.headers.get("range"), upload.fileSizeBytes);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { ...NO_STORE, "Content-Range": `bytes */${upload.fileSizeBytes}`, "Accept-Ranges": "bytes" },
      });
    }
    const media = await readCinemaMediaObject({ upload, range });
    if (!media) return Response.json({ error: "That video is no longer available." }, { status: 404, headers: NO_STORE });
    return new Response(media.body, {
      status: media.partial ? 206 : 200,
      headers: {
        ...NO_STORE,
        "Content-Type": media.contentType,
        "Content-Length": String(media.length),
        "Accept-Ranges": "bytes",
        ...(media.partial ? { "Content-Range": `bytes ${media.offset}-${media.offset + media.length - 1}/${media.totalBytes}` } : {}),
      },
    });
  } catch (error) {
    return fail(error, request);
  }
}

/** Some players probe with HEAD before they stream; answer without the bytes. */
export async function HEAD(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const claims = await verifyCinemaMediaToken((await context.params).token);
    if (!claims) return new Response(null, { status: 401, headers: NO_STORE });
    const upload = await cinemaUploadForToken(claims);
    // One byte proves the object is still there without fetching the video.
    const media = await readCinemaMediaObject({ upload, range: { offset: 0, length: 1 } });
    if (!media) return new Response(null, { status: 404, headers: NO_STORE });
    await media.body.cancel().catch(() => undefined);
    return new Response(null, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": media.contentType,
        "Content-Length": String(upload.fileSizeBytes),
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    return fail(error, request);
  }
}
