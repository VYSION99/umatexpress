"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom } from "@/lib/cinema-engine/rooms";
import { CinemaQuestionsPanel } from "./CinemaQuestionsPanel";
import { CinemaPollsPanel } from "./CinemaPollsPanel";

type StageState = { status: string; title: string; videoId: string; role: string };

/** Large audiences watch one broadcast. They do not join the six-person WebRTC mesh. */
export function CinemaDiscussionAudience({ initialRoom, onStageRole }: { initialRoom: CinemaRoom; onStageRole: (role: string) => void }) {
  const { ready, account } = useStudentAccount();
  const [room, setRoom] = useState(initialRoom);
  const [state, setState] = useState<StageState>({ status: initialRoom.status, title: initialRoom.title, videoId: initialRoom.videoId, role: "VIEWER" });
  const [requestPending, setRequestPending] = useState(false);
  const [tab, setTab] = useState<"questions" | "polls">("questions");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const joining = useRef(false);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/cinema/sessions/${room.id}/stage`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!response) return;
    if (response.status === 401 || response.status === 403) {
      setRoom(current => ({ ...current, isMember: false, videoId: "" }));
      setState(current => ({ ...current, videoId: "" }));
      setError("Your place in this discussion is no longer active.");
      return;
    }
    if (!response.ok) return;
    const data = await response.json() as { state?: StageState; requests?: Array<{ studentId: string }> };
    if (data.state) {
      setState(data.state);
      if (["HOST", "COHOST", "PRESENTER"].includes(data.state.role)) onStageRole(data.state.role);
    }
    setRequestPending(Boolean(account && data.requests?.some(item => item.studentId === account.id)));
  }, [account, onStageRole, room.id]);

  useEffect(() => {
    if (!ready || !account?.emailVerified || joining.current || room.isMember || !["CREATED", "LIVE"].includes(room.status)) return;
    joining.current = true;
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${room.id}/join`, { method: "POST", credentials: "same-origin" });
        const data = await response.json() as { room?: CinemaRoom; error?: string };
        if (!response.ok || !data.room) throw new Error(data.error || "Could not join this discussion.");
        setRoom(data.room);
      } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not join this discussion."); }
    })();
  }, [account, ready, room]);
  useEffect(() => {
    if (!room.isMember || !account?.emailVerified) return;
    queueMicrotask(() => void refresh());
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000 + Math.floor(Math.random() * 5_000));
    return () => clearInterval(timer);
  }, [account, refresh, room.isMember]);
  useEffect(() => {
    if (!room.isMember || state.status !== "LIVE") return;
    const heartbeat = () => { void fetch(`/api/cinema/sessions/${room.id}/stage`, { method: "PUT", credentials: "same-origin" }).catch(() => undefined); };
    heartbeat();
    const timer = setInterval(() => { if (!document.hidden) heartbeat(); }, 60_000);
    return () => clearInterval(timer);
  }, [room.id, room.isMember, state.status]);

  const requestToSpeak = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${room.id}/stage`, { method: "POST", credentials: "same-origin" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not request the stage.");
      setRequestPending(true);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not request the stage."); }
    finally { setBusy(false); }
  };

  if (!ready) return <section className="cinema-card">Checking your account…</section>;
  if (!account || !account.emailVerified) return <section className="cinema-card"><h2>{account ? "Verify your email" : "Sign in to attend"}</h2><p>{account ? "You are signed in. Confirm your email before joining this discussion." : "Any verified account may join this public discussion."}</p><Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/${room.id}`)}`}>{account ? "Verify your email" : "Sign in or create an account"}</Link></section>;
  if (error && !room.isMember) return <section className="cinema-card"><h2>Could not join</h2><p className="cinema-error" role="alert">{error}</p><Link href="/cinema/events">Browse events</Link></section>;
  return <section className="cinema-discussion-audience" aria-label="Discussion audience">
    <div className="cinema-discussion-broadcast">
      <div className="cinema-discussion-broadcast-head"><div><span className="cinema-eyebrow">PUBLIC DISCUSSION</span><h2>{state.title}</h2></div><span className={`cinema-event-state is-${state.status.toLowerCase()}`}>{state.status === "LIVE" ? "Live now" : state.status === "ENDED" ? "Ended" : "Upcoming"}</span></div>
      <div className="cinema-discussion-video">{room.isMember && state.status !== "ENDED" ? <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(state.videoId)}?autoplay=1`} title={`${state.title} live broadcast`} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen /> : <p className="cinema-discussion-video-message">{state.status === "ENDED" ? "This discussion has ended." : "Confirming your reserved place…"}</p>}</div>
      <div className="cinema-discussion-broadcast-foot"><p>You are watching the broadcast. The host invites speakers onto the separate stage.</p><button className="secondary" disabled={busy || requestPending || state.status === "ENDED" || !room.isMember} onClick={() => void requestToSpeak()}>{requestPending ? "Speaking request sent" : "Request to speak"}</button></div>
      {error && <p className="cinema-error" role="alert">{error}</p>}
    </div>
    <aside className="cinema-discussion-side"><div className="cinema-discussion-tabs" role="tablist" aria-label="Audience participation"><button role="tab" aria-selected={tab === "questions"} onClick={() => setTab("questions")}>Questions</button><button role="tab" aria-selected={tab === "polls"} onClick={() => setTab("polls")}>Polls</button></div>{room.isMember ? tab === "questions" ? <CinemaQuestionsPanel roomId={room.id} canManage={false} /> : <CinemaPollsPanel roomId={room.id} canManage={false} /> : <p className="cinema-note">Joining the audience…</p>}</aside>
  </section>;
}
