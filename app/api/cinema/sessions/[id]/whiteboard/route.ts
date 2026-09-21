import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { cinemaBoardPolicy, removeCinemaWhiteboardFromRoom } from "@/lib/cinema-engine/realtime";
import { isRoomActive, isRoomVisible, readRoom } from "@/lib/cinema-engine/rooms";
import {
  askCinemaWhiteboard,
  cinemaWhiteboardById,
  cinemaWhiteboardLimits,
  deleteCinemaWhiteboard,
  listCinemaWhiteboards,
} from "@/lib/cinema-engine/whiteboard";
import { platformSettingNumber } from "@/lib/platform-settings";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The room's AI whiteboard.
 *
 * Reading is open to any member while the room is visible: a board is part of
 * the session's memory, and a room that just ended still explains itself. Asking
 * needs an open room and a member, and the pace is a console setting — each
 * board is a model call billed to this deployment. Clearing is the host's, or
 * the asker taking their own board back; the socket carries both events so
 * every open screen agrees without a reload.
 *
 * The live room also decides who may ask — host only, everyone, or automatic —
 * and the route reads that switch before it calls the model, so a question the
 * room would refuse never costs a generation. An automatic pass is the host's
 * own screen asking on a cadence; its question is written in the engine.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-whiteboard-read", student.id, { limit: 240, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const room = await readRoom({ id, studentId: student.id });
    if (!isRoomVisible(room.status)) throw new CampusEngineError("NOT_FOUND", "That room does not exist.", 404);
    if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join the room to see its whiteboard.", 403);

    const boardId = new URL(request.url).searchParams.get("boardId") || "";
    const limits = await cinemaWhiteboardLimits();
    if (boardId) {
      const board = await cinemaWhiteboardById({ boardId, roomId: room.id });
      return ok({ board: board.view, limits }, { headers: NO_STORE }, request);
    }
    const boards = await listCinemaWhiteboards({ roomId: room.id });
    return ok({ boards: boards.map((board) => board.view), limits }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const pace = Math.max(1, Math.floor(await platformSettingNumber("cinema_whiteboard_generations_per_hour")));
    const limited = await rateLimitSubject("cinema-whiteboard-ask", student.id, { limit: pace, windowMs: 60 * 60_000 });
    if (!limited.ok) {
      return rateLimitResponse(limited.retryAfter);
    }
    const { id } = await context.params;
    const body = await request.json() as { question?: unknown; mode?: unknown; atSeconds?: unknown; auto?: unknown };
    const auto = body.auto === true;
    const policy = await cinemaBoardPolicy(id);
    const board = await askCinemaWhiteboard({
      roomId: id,
      student: { id: student.id, name: student.name },
      question: body.question,
      mode: body.mode,
      atSeconds: body.atSeconds,
      policy,
      auto,
    });
    return ok({ board: board.view }, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-whiteboard-clear", student.id, { limit: 120, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const boardId = new URL(request.url).searchParams.get("boardId") || "";
    if (!boardId) throw new CampusEngineError("VALIDATION_ERROR", "A board id is required.", 400);
    const room = await readRoom({ id, studentId: student.id });
    if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join the room to clear its whiteboard.", 403);
    if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
    const result = await deleteCinemaWhiteboard({
      boardId,
      roomId: room.id,
      actor: { id: student.id, isHost: room.isHost },
    });
    await removeCinemaWhiteboardFromRoom(room.id, result.id);
    return ok({ deleted: result.deleted, id: result.id }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
