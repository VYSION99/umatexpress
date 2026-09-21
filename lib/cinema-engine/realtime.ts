import { cinemaRoomNamespace } from "@/lib/cloudflare-bindings";
import { logEvent } from "@/lib/observability";

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
