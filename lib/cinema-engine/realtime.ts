import { cinemaRoomNamespace } from "@/lib/cloudflare-bindings";
import { logEvent } from "@/lib/observability";

/** What a room's Durable Object knows about who is attached right now. */
export type CinemaRoomPresence = { memberCount: number; emptySince: number };

/**
 * Tells a room's Durable Object that the room is over.
 *
 * Best-effort by design: ending a room is a database decision that has already
 * succeeded by the time this runs, and a deployment without the binding (local
 * preview, unit tests) or a failed nudge must not turn that success into an
 * error. The sockets are a courtesy; the row is the truth.
 */
export async function closeCinemaRoom(roomId: string) {
  const namespace = await cinemaRoomNamespace();
  if (!namespace) return;
  try {
    const stub = namespace.get(namespace.idFromName(String(roomId)));
    await stub.fetch("https://cinema-room/close", { method: "POST" });
  } catch (error) {
    logEvent("warn", "cinema_room_close_failed", {
      roomId: String(roomId),
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Tells a live room that a message was taken down, so the open sockets drop it
 * along with the row. Best-effort for the same reason as `closeCinemaRoom`:
 * the deletion already happened in the database, and a missing socket must not
 * make the moderator's action look failed.
 */
export async function purgeCinemaMessageFromRoom(roomId: string, messageId: string) {
  const namespace = await cinemaRoomNamespace();
  if (!namespace) return;
  try {
    const stub = namespace.get(namespace.idFromName(String(roomId)));
    await stub.fetch("https://cinema-room/purge-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: String(messageId) }),
    });
  } catch (error) {
    logEvent("warn", "cinema_message_purge_failed", {
      roomId: String(roomId),
      messageId: String(messageId),
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Asks a room whether anybody is attached, and since when nobody was.
 *
 * Only the Durable Object can answer this: presence lives in socket
 * attachments, and the database rows cannot tell a viewer from a closed tab.
 * `null` means the answer is unavailable — no binding, no object, a failed
 * fetch — and callers must treat that as "do not guess", never as "empty".
 */
export async function cinemaRoomPresence(roomId: string): Promise<CinemaRoomPresence | null> {
  const namespace = await cinemaRoomNamespace();
  if (!namespace) return null;
  try {
    const stub = namespace.get(namespace.idFromName(String(roomId)));
    const response = await stub.fetch("https://cinema-room/presence", { method: "GET" });
    if (!response.ok) return null;
    const data = await response.json() as { members?: unknown[]; emptySince?: unknown };
    const emptySince = Number(data.emptySince);
    return {
      memberCount: Array.isArray(data.members) ? data.members.length : 0,
      emptySince: Number.isFinite(emptySince) && emptySince > 0 ? emptySince : 0,
    };
  } catch (error) {
    logEvent("warn", "cinema_room_presence_failed", {
      roomId: String(roomId),
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}
