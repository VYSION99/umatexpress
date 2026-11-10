"use client";

import { useEffect, useState } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom } from "@/lib/cinema-engine/rooms";

/** Never hand a previous account's room snapshot to a newly signed-in user. */
export function useCinemaRoomAccess(roomId: string) {
  const { ready, account } = useStudentAccount();
  const accountId = account?.id || "";
  const verified = account?.emailVerified === true;
  const [result, setResult] = useState<{ roomId: string; accountId: string; room?: CinemaRoom; error?: string } | null>(null);
  if (result && (!verified || result.accountId !== accountId || result.roomId !== roomId)) setResult(null);
  useEffect(() => {
    if (!ready || !accountId || !verified) return;
    let disposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "x-cinema-account": accountId },
        });
        const data = await response.json() as { room?: CinemaRoom; error?: string };
        if (disposed) return;
        setResult(response.ok && data.room
          ? { roomId, accountId, room: data.room }
          : { roomId, accountId, error: data.error || "This room is no longer available to you." });
      } catch {
        if (!disposed) setResult({ roomId, accountId, error: "Could not check your room access. Reload to try again." });
      }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [ready, accountId, verified, roomId]);
  const current = ready && verified && accountId && result?.roomId === roomId && result.accountId === accountId ? result : null;
  return { ready, account, room: current?.room, error: current?.error };
}
