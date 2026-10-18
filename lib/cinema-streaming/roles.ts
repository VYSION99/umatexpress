import { setRoomMemberRole } from "@/lib/cinema-engine/rooms";
import { admitFreeStageIdentityBySession, releaseFreeStageIdentityDevicesBySession } from "@/lib/cinema-streaming/entitlements";

/**
 * The user-facing role boundary. Ordinary rooms pass through unchanged. A
 * managed event also consumes its immutable unique-stage admission before the
 * promoted account can request a provider token.
 */
export async function setStreamingAwareRoomMemberRole(input: { id: string; studentId: string; guestId: unknown; role: unknown }) {
  const role = String(input.role || "").trim().toUpperCase();
  const changed = await setRoomMemberRole(input);
  if (role === "VIEWER") {
    await releaseFreeStageIdentityDevicesBySession({ sessionId: input.id, studentId: String(input.guestId || "") });
    return changed;
  }
  if (role === "COHOST" || role === "PRESENTER") {
    try {
      await admitFreeStageIdentityBySession({ sessionId: input.id, studentId: String(input.guestId || "") });
    } catch (error) {
      await setRoomMemberRole({ ...input, role: "VIEWER" }).catch(() => undefined);
      throw error;
    }
  }
  return changed;
}
