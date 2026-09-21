import { fail } from "@/lib/campus-engine/responses";
import { cinemaRecordingForRecorder, cinemaRecordingObject } from "@/lib/cinema-engine/recordings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

/**
 * The recorder's own bytes.
 *
 * The object key never travels to the browser: the route reads the row, checks
 * that the caller is the recorder, and streams the object through the Worker.
 * A download is a file the student asked for, so it may outlive its room — but
 * only for them, and only until the retention window deletes it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-recording-file", student.id, { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const recording = await cinemaRecordingForRecorder({ recordingId: id, studentId: student.id });
    const object = await cinemaRecordingObject({ recording });
    const extension = recording.mimeType === "video/mp4" ? "mp4" : recording.mimeType === "audio/mp4" ? "m4a" : "webm";
    const filename = `umatexpress-recording-${recording.id.slice(0, 8)}.${extension}`;
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": recording.mimeType || "application/octet-stream",
        "content-length": String(object.size ?? recording.fileSizeBytes),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return fail(error, request);
  }
}
