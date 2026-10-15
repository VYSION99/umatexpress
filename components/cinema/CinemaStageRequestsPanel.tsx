"use client";

import { useCallback, useEffect, useState } from "react";

type SpeakingRequest = { studentId: string; displayName: string; requestedAt: string };

export function CinemaStageRequestsPanel({ roomId, stageLimit }: { roomId: string; stageLimit: number }) {
  const [requests, setRequests] = useState<SpeakingRequest[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/cinema/sessions/${roomId}/stage`, { cache: "no-store", credentials: "same-origin" }).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json() as { requests?: SpeakingRequest[] };
    setRequests(data.requests || []);
  }, [roomId]);
  useEffect(() => { queueMicrotask(() => void load()); const timer = setInterval(() => void load(), 5_000); return () => clearInterval(timer); }, [load]);
  const decide = async (guestId: string, action: "APPROVE" | "REJECT") => {
    setBusy(guestId); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/stage`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ guestId, action }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not decide that request.");
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not decide that request."); }
    finally { setBusy(""); }
  };
  return <section className="cinema-stage-requests"><h3>Speaking requests <span>{requests.length}</span></h3><p className="cinema-note">Up to {stageLimit} speakers including the host. Move a speaker back to the audience to free a place.</p>
    {error && <p className="cinema-error" role="alert">{error}</p>}
    {requests.length ? <ul>{requests.map(request => <li key={request.studentId}><strong>{request.displayName}</strong><div><button disabled={Boolean(busy)} onClick={() => void decide(request.studentId, "APPROVE")}>Invite to stage</button><button className="secondary" disabled={Boolean(busy)} onClick={() => void decide(request.studentId, "REJECT")}>Decline</button></div></li>)}</ul> : <p className="cinema-note">No speaking requests yet.</p>}
  </section>;
}
