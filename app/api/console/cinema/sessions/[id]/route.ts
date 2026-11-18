import { CampusEngineError, campusErrorPayload } from "@/lib/campus-engine/errors";
import { removeCinemaMessage } from "@/lib/cinema-engine/messages";
import { purgeCinemaMessageFromRoom } from "@/lib/cinema-engine/realtime";
import { endRoomAsStaff, kickParticipantAsStaff, lockRoomAsStaff, readRoomForConsole } from "@/lib/cinema-engine/rooms";
import { takeDownCinemaUpload } from "@/lib/cinema-engine/uploads";
import { consoleAudit } from "@/lib/console-audit";
import { requireConsoleRole } from "@/lib/console-auth";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A moderator inspects one room: metadata, host, participant roster, video status,
 * recent chat messages and open signals.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const room = await readRoomForConsole(id);
    return Response.json({ ok: true, room }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}

/**
 * A moderator acts on one room: end it, lock/unlock join doors, kick a disruptive participant,
 * remove one message, or take the room's uploaded video down.
 *
 * Every action is audited against the staff account and conditional in the
 * engine — ending an already-ended room, removing an already-removed message
 * and taking down an already-removed video report the truth rather than
 * succeeding twice.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"]);
    const limited = await rateLimit(request, "cinema-console-write", { limit: 120, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as {
      action?: unknown;
      messageId?: unknown;
      reason?: unknown;
      locked?: unknown;
      studentId?: unknown;
    };
    const action = String(body.action || "").trim().toUpperCase();

    if (action === "END_ROOM") {
      const room = await endRoomAsStaff({ roomId: id, actor: account.email });
      return Response.json({ ok: true, room }, { headers: NO_STORE });
    }

    if (action === "LOCK_ROOM" || action === "UNLOCK_ROOM") {
      const locked = action === "LOCK_ROOM";
      const result = await lockRoomAsStaff({ roomId: id, locked, actor: account.email });
      return Response.json({ ok: true, result }, { headers: NO_STORE });
    }

    if (action === "KICK_PARTICIPANT") {
      const studentId = String(body.studentId || "").trim();
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      const result = await kickParticipantAsStaff({ roomId: id, studentId, actor: account.email, reason });
      return Response.json({ ok: true, result }, { headers: NO_STORE });
    }

    if (action === "REMOVE_MESSAGE") {
      const message = await removeCinemaMessage(String(body.messageId || ""), id);
      // The row is gone; the open sockets are told so the room stops showing it.
      await purgeCinemaMessageFromRoom(id, message.id);
      await consoleAudit({
        actor: account.email,
        action: "cinema_message_removed",
        targetType: "cinema_message",
        targetReference: message.id,
        details: { roomId: id, senderId: message.senderId, excerpt: message.content.slice(0, 160) },
      });
      return Response.json({ ok: true, message: { id: message.id, roomId: id } }, { headers: NO_STORE });
    }

    if (action === "REMOVE_VIDEO") {
      const removal = await takeDownCinemaUpload({ roomId: id, actor: account.email, reason: body.reason });
      return Response.json({ ok: true, removal }, { headers: NO_STORE });
    }

    throw new CampusEngineError("VALIDATION_ERROR", "That is not an action a room understands.", 400);
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
