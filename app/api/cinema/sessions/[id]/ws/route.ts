import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail } from "@/lib/campus-engine/responses";
import { isRoomActive, readRoom } from "@/lib/cinema-engine/rooms";
import { cinemaRoomNamespace } from "@/lib/cloudflare-bindings";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

/**
 * The live connection to one room.
 *
 * This route is the only door to the Durable Object, and that is deliberate:
 * the object trusts the headers it is handed, so the Worker does the one thing
 * the object cannot — read the student session, check the room in the database,
 * and refuse before a socket exists. The client's own headers are never
 * forwarded: the object sees a fresh request carrying only what was checked.
 *
 * A room that is ending, ended, locked to this student or never theirs is a
 * JSON error with an ordinary HTTP status, because the refusal happens before
 * the upgrade rather than inside it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = await rateLimit(request, "cinema-socket", { limit: 60, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const student = await requireStudent(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new CampusEngineError("VALIDATION_ERROR", "This endpoint speaks WebSocket, not HTTP.", 426);
    }

    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
    if (!room.isMember) {
      throw new CampusEngineError(
        "FORBIDDEN",
        room.joinLocked ? "The host has locked this room." : "Join the room before opening its live connection.",
        403,
      );
    }

    const namespace = await cinemaRoomNamespace();
    if (!namespace) {
      throw new CampusEngineError("CONFIG_REQUIRED", "Live rooms are not available in this deployment.", 503);
    }

    const forwarded = new Request("https://cinema-room/socket", request);
    // Set after the copy, so a client that sends these headers itself is
    // overwritten rather than believed.
    forwarded.headers.set("upgrade", "websocket");
    forwarded.headers.set("x-cinema-attachment", encodeURIComponent(JSON.stringify({
      studentId: student.id,
      displayName: String(student.name || "").slice(0, 80),
    })));
    forwarded.headers.set("x-cinema-room", encodeURIComponent(JSON.stringify({
      roomId: room.id,
      hostStudentId: room.hostStudentId,
      title: room.title,
      sourceType: room.sourceType,
      videoId: room.videoId,
    })));

    const stub = namespace.get(namespace.idFromName(room.id));
    const upstream = await stub.fetch(forwarded);
    if (upstream.status !== 101) return upstream;
    // A Response handed back by a stub fetch has immutable headers, and the App
    // Router's finalizer writes a Vary header onto every non-redirect response
    // — which turns the upgrade into a 500. A fresh 101 carrying the same
    // socket has headers the platform can decorate and upgrades as normal.
    const socket = (upstream as Response & { webSocket?: unknown }).webSocket;
    return new Response(null, { status: 101, webSocket: socket } as ResponseInit);
  } catch (error) {
    return fail(error, request);
  }
}
