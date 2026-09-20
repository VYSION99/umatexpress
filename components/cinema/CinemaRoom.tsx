"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, LockOpen, Play, Radio, Square } from "lucide-react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom as Room } from "@/lib/cinema-engine/rooms";
import "./cinema.css";

/**
 * The room as a student sees it.
 *
 * Membership is the server's answer, never the client's assumption: this joins
 * once on open, and only while the room is open, then re-reads it so the list
 * shows the database's version of who joined. The list is membership, not live
 * presence — the Durable Object that knows who is connected arrives with M2,
 * and until then the refresh button is the honest way to update it.
 *
 * Host controls are hidden from everyone else, but that is a courtesy: the
 * engine refuses a non-host's action regardless.
 */
export function CinemaRoom({ initialRoom }: { initialRoom: Room }) {
  const { ready, account } = useStudentAccount();
  const [room, setRoom] = useState<Room>(initialRoom);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const joined = useRef(false);
  const enteredStatus = useRef(initialRoom.status);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/cinema/sessions/${initialRoom.id}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { room?: Room };
      if (data.room) setRoom(data.room);
    } catch { /* a failed refresh leaves the last known room on screen */ }
  }, [initialRoom.id]);

  useEffect(() => {
    if (!ready || !account || joined.current) return;
    // An ended room takes no joins, and asking anyway would paint an error over
    // the page that is already explaining itself.
    if (enteredStatus.current !== "CREATED" && enteredStatus.current !== "LIVE") return;
    joined.current = true;
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${initialRoom.id}/join`, { method: "POST", credentials: "same-origin" });
        const data = await response.json() as { room?: Room; error?: string };
        if (!response.ok) { setError(data.error || "The room could not be joined."); return; }
        if (data.room) setRoom(data.room);
      } catch {
        setError("The room could not be joined.");
      }
    })();
  }, [ready, account, initialRoom.id]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${initialRoom.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await response.json() as { room?: Room; error?: string };
      if (!response.ok) throw new Error(data.error || "That change was refused.");
      if (data.room) setRoom(data.room);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That change was refused.");
    } finally {
      setBusy("");
    }
  };

  const share = async () => {
    const link = `${window.location.origin}/cinema/${room.id}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Copy did not work in this browser. The link is above — select it and copy.");
    }
  };

  const active = room.status === "CREATED" || room.status === "LIVE";
  const watchUrl = room.sourceType === "YOUTUBE" && room.videoId ? `https://www.youtube.com/watch?v=${room.videoId}` : "";

  return <div className="cinema-room">
    <div className="cinema-stage">
      <section className="cinema-video">
        <strong>{room.title}</strong>
        <span>
          {room.sourceType === "YOUTUBE" ? "One YouTube video is attached to this room." : "This room has an uploaded video."}
          {active ? " The synced player arrives in the next update — open the video from here in the meantime." : " This room is closed."}
        </span>
        {watchUrl && active && <a href={watchUrl} target="_blank" rel="noreferrer">Open the video on YouTube</a>}
      </section>

      <section className="cinema-share">
        <strong>Invite</strong>
        <code>{`/cinema/${room.id}`}</code>
        <button onClick={() => void share()}>{copied ? "Link copied" : "Copy the room link"}</button>
      </section>

      {room.isHost && active && <section className="cinema-card">
        <h2>Host controls</h2>
        <div className="cinema-controls">
          {room.status === "CREATED" && <button disabled={Boolean(busy)} onClick={() => void act("OPEN")}><Play size={15} /> Open the room</button>}
          {room.status === "LIVE" && <span className="cinema-chip is-live"><Radio size={12} /> Live</span>}
          {room.joinLocked
            ? <button className="secondary" disabled={Boolean(busy)} onClick={() => void act("UNLOCK")}><LockOpen size={15} /> Let people in again</button>
            : <button className="secondary" disabled={Boolean(busy)} onClick={() => void act("LOCK")}><Lock size={15} /> Lock the door</button>}
          <button className="danger" disabled={Boolean(busy)} onClick={() => void act("END")}><Square size={15} /> End the room</button>
        </div>
        <p className="cinema-note cinema-sub">
          {room.joinLocked
            ? "The door is locked: only students already in can come back in."
            : "Anyone with the link and a UMaT account can join."}
        </p>
      </section>}

      {error && <p className="cinema-error">{error}</p>}
    </div>

    <aside className="cinema-card">
      <h2>Who joined</h2>
      {!ready
        ? <p className="cinema-note">Checking your account…</p>
        : !account
          ? <>
            <p className="cinema-note">Sign in with your <strong>@st.umat.edu.gh</strong> account to join and appear here.</p>
            <div className="cinema-controls cinema-sub">
              <Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/${room.id}`)}`}>Sign in to join</Link>
            </div>
          </>
          : <ul className="cinema-people">
            {room.participants.map((member) => <li key={member.studentId}>
              {member.displayName || "Member"}
              <span>{member.studentId === room.hostStudentId ? "Host" : "Member"}</span>
            </li>)}
          </ul>}
      {account && <div className="cinema-controls cinema-sub">
        <button className="secondary" onClick={() => void load()}>Refresh the list</button>
      </div>}
      <p className="cinema-note cinema-sub">
        {room.status === "ENDED"
          ? "This room has ended. Nobody new can join."
          : room.joinLocked
            ? "The host locked the door, so only people already in can come back."
            : "Everyone with the link and a UMaT account can join. The list updates when you refresh."}
      </p>
    </aside>
  </div>;
}
