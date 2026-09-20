"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Clapperboard } from "lucide-react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom } from "@/lib/cinema-engine/rooms";
import "./cinema.css";

/**
 * The lobby: start a room, or walk into one from a link.
 *
 * Creating a room needs an account because a room has a host and a membership
 * row; watching the lobby list needs the same account for the same reason. The
 * shared link is the only thing a signed-out visitor can hold, so pasting one
 * sends them through sign-in and back.
 */
export function CinemaLobby() {
  const router = useRouter();
  const { ready, account } = useStudentAccount();
  const [title, setTitle] = useState("");
  const [video, setVideo] = useState("");
  const [link, setLink] = useState("");
  const [rooms, setRooms] = useState<CinemaRoom[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cinema/sessions", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { rooms?: CinemaRoom[] };
      setRooms(data.rooms || []);
    } catch { /* the list is a convenience, not a gate: a failure leaves it empty */ }
  }, []);

  useEffect(() => { if (account) queueMicrotask(load); }, [account, load]);

  const create = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cinema/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, video }),
      });
      const data = await response.json() as { room?: CinemaRoom; error?: string };
      if (!response.ok || !data.room) throw new Error(data.error || "The room could not be created.");
      router.push(`/cinema/${data.room.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The room could not be created.");
      setBusy(false);
    }
  };

  const open = () => {
    const id = roomIdFrom(link);
    if (!id) { setError("Paste the room link you were sent."); return; }
    setError("");
    router.push(`/cinema/${id}`);
  };

  if (!ready) return <section className="cinema-card"><p className="cinema-note">Checking your account…</p></section>;

  if (!account) return <section className="cinema-card">
    <h2>Sign in to open a room</h2>
    <p className="cinema-note">Cinema rooms are for UMaT students. Sign in with your <strong>@st.umat.edu.gh</strong> account and the room you were sent is waiting.</p>
    <div className="cinema-controls cinema-sub">
      <Link className="cinema-cta" href="/account?next=%2Fcinema">Sign in <Clapperboard size={16} /></Link>
    </div>
  </section>;

  return <div className="cinema-lobby">
    <section className="cinema-card">
      <h2>Start a room</h2>
      <p className="cinema-note">Attach one YouTube video. Everyone who opens the link watches the same thing and stays in the same conversation.</p>
      <div className="cinema-create">
        <label>Room name
          <input value={title} maxLength={80} placeholder="PHY 201 — revision" onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>YouTube link
          <input value={video} placeholder="https://youtu.be/…" onChange={(event) => setVideo(event.target.value)} />
        </label>
        {error && <p className="cinema-error">{error}</p>}
        <button disabled={busy || !video.trim()} onClick={() => void create()}>{busy ? "Opening…" : "Open the room"}</button>
      </div>
    </section>

    <aside className="cinema-card">
      <h2>Join a room</h2>
      <div className="cinema-create">
        <label>Room link
          <input value={link} placeholder="/cinema/… or the full link" onChange={(event) => setLink(event.target.value)} />
        </label>
        <button disabled={!link.trim()} onClick={open}>Go to the room</button>
      </div>

      <h2 className="cinema-heading">Your rooms</h2>
      {rooms.length === 0
        ? <p className="cinema-note">Rooms you host or join appear here, newest first.</p>
        : <ul className="cinema-rooms">
          {rooms.map((room) => <li className="cinema-room-row" key={room.id}>
            <div>
              <Link href={`/cinema/${room.id}`}>{room.title}</Link>
              <small>{room.isHost ? "You host this" : `Hosted by ${room.hostName}`} · {room.verifiedCount} {room.verifiedCount === 1 ? "person" : "people"}</small>
            </div>
            <span className={`cinema-chip${room.status === "LIVE" ? " is-live" : room.status === "ENDED" ? " is-ended" : ""}`}>{room.status}</span>
          </li>)}
        </ul>}
    </aside>
  </div>;
}

/** A room id out of a pasted link, a bare id, or nothing. */
function roomIdFrom(value: string) {
  const trimmed = value.trim().split(/[?#]/)[0];
  const candidate = trimmed.includes("/") ? trimmed.split("/").filter(Boolean).pop() || "" : trimmed;
  return /^[A-Za-z0-9-]{8,64}$/.test(candidate) ? candidate : "";
}
