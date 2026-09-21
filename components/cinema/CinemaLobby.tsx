"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Globe, Link2, Lock, Search, Upload } from "lucide-react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom } from "@/lib/cinema-engine/rooms";
import type { YouTubeSearchResult } from "@/lib/cinema-engine/youtube";
import { UploadPanel } from "./UploadPanel";
import "./cinema.css";

/** Where the room's video comes from, decided before the room exists. */
type CinemaSource = "YOUTUBE" | "UPLOAD";
/** Who may walk in, decided before the room exists. */
type CinemaDoor = "PUBLIC" | "PRIVATE";

/**
 * The lobby: start a room, or walk into one from a link.
 *
 * The choices a room is made of are made here, not inside the room: where the
 * video comes from — a YouTube link, or a file the host uploads next — and who
 * may walk in. An upload runs here beside the room it fills, and an upload room
 * is private from the moment it exists, because the engine closes that door
 * before a byte arrives. A host who changes their mind about the door does it
 * from the room list below; the room itself carries neither control.
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
  const [source, setSource] = useState<CinemaSource>("YOUTUBE");
  const [door, setDoor] = useState<CinemaDoor>("PUBLIC");
  /** Minutes from now the room opens; 0 means it is live on creation. */
  const [startIn, setStartIn] = useState("0");
  /** The host's run time in minutes; 0 means only the host ends the room. */
  const [runsFor, setRunsFor] = useState("0");
  const [link, setLink] = useState("");
  const [rooms, setRooms] = useState<CinemaRoom[]>([]);
  /** The room waiting for its file; the upload step runs here, not in the room. */
  const [uploadRoom, setUploadRoom] = useState<CinemaRoom | null>(null);
  const [busy, setBusy] = useState(false);
  /** The room whose door is being flipped, so only its chip goes quiet. */
  const [roomBusy, setRoomBusy] = useState("");
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  /** The YouTube search: what was typed, the tray it returned, and the video it filled in. */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YouTubeSearchResult[]>([]);
  const [picked, setPicked] = useState<YouTubeSearchResult | null>(null);
  const [search, setSearch] = useState<{ busy: boolean; error: string; done: boolean }>({ busy: false, error: "", done: false });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cinema/sessions", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { rooms?: CinemaRoom[] };
      setRooms(data.rooms || []);
    } catch { /* the list is a convenience, not a gate: a failure leaves it empty */ }
  }, []);

  useEffect(() => { if (account) queueMicrotask(load); }, [account, load]);

  /** Typing drops the last tray: it belonged to the words that are gone. */
  const searchFor = (value: string) => {
    setQuery(value);
    setResults([]);
    setSearch({ busy: false, error: "", done: false });
  };

  // One search per pause in typing, and never two in flight: the moment the
  // query changes the request before it is aborted, so a slow answer for
  // half-typed words can never land on top of a faster one for the real ones.
  useEffect(() => {
    const text = query.trim();
    if (!account || text.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearch({ busy: true, error: "", done: false });
      fetch(`/api/cinema/youtube?q=${encodeURIComponent(text)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const data = await response.json() as { results?: YouTubeSearchResult[]; error?: string };
          if (!response.ok) throw new Error(data.error || "That search could not be run.");
          return data.results || [];
        })
        .then((rows) => { setResults(rows); setSearch({ busy: false, error: "", done: true }); })
        .catch((searchError: unknown) => {
          if (controller.signal.aborted) return;
          setResults([]);
          setSearch({ busy: false, error: searchError instanceof Error ? searchError.message : "That search could not be run.", done: true });
        });
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, query]);

  /** The tray's one job: put the video in the form below and let the host name the room. */
  const pick = (result: YouTubeSearchResult) => {
    setPicked(result);
    setVideo(`https://www.youtube.com/watch?v=${result.videoId}`);
    setSource("YOUTUBE");
    if (!title.trim()) setTitle(result.title.slice(0, 80));
    setResults([]);
    setSearch({ busy: false, error: "", done: false });
  };

  // A file makes its room private, and the engine would refuse any other
  // answer; the form shows that rather than pretending the choice is open.
  const createsPrivate = source === "UPLOAD" || door === "PRIVATE";
  const isActive = (room: CinemaRoom) => room.status === "CREATED" || room.status === "LIVE";

  const create = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cinema/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          video,
          source,
          visibility: createsPrivate ? "PRIVATE" : "PUBLIC",
          // The clock rides with the door and the source: the engine decides
          // what the numbers may be, and a scheduled room is armed before the
          // lobby's next screen renders.
          startInMinutes: Number(startIn),
          durationMinutes: Number(runsFor),
        }),
      });
      const data = await response.json() as { room?: CinemaRoom; error?: string };
      if (!response.ok || !data.room) throw new Error(data.error || "The room could not be created.");
      // An upload room waits here for its file: the room has to exist before
      // the upload can name it, so creating and uploading are two steps and
      // the second one never happens anywhere near the room itself.
      if (source === "UPLOAD") { setUploadRoom(data.room); setBusy(false); return; }
      router.push(`/cinema/${data.room.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The room could not be created.");
      setBusy(false);
    }
  };

  /** Flips a hosted room's door; the engine checks the host, not the button. */
  const flipDoor = async (room: CinemaRoom) => {
    setRoomBusy(room.id); setListError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${room.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: room.isPrivate ? "PUBLIC" : "PRIVATE" }),
      });
      const data = await response.json() as { room?: CinemaRoom; error?: string };
      if (!response.ok || !data.room) throw new Error(data.error || "That change was refused.");
      setRooms((current) => current.map((row) => (row.id === room.id ? data.room as CinemaRoom : row)));
    } catch (flipError) {
      setListError(flipError instanceof Error ? flipError.message : "That change was refused.");
    } finally {
      setRoomBusy("");
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
    {uploadRoom
      ? <section className="cinema-card">
        <h2>Add the file</h2>
        <p className="cinema-note">
          <strong>{uploadRoom.title}</strong> is created and invite-only. Uploads live in the private bucket, so the share link alone can never open it;
          the moment the file is ready the room starts playing it.
        </p>
        <UploadPanel
          roomId={uploadRoom.id}
          onUploaded={() => { void load(); router.push(`/cinema/${uploadRoom.id}`); }}
        />
        <p className="cinema-note cinema-sub">
          No file right now?{" "}
          <button type="button" className="cinema-text-button" onClick={() => router.push(`/cinema/${uploadRoom.id}`)}>Open the room without it</button>
          {" "}— you can add the file from this lobby later.{" "}
          <button type="button" className="cinema-text-button" onClick={() => setUploadRoom(null)}>Start a different room</button>.
        </p>
      </section>
      : <>
      <section className="cinema-card cinema-search-card">
        <h2>Find a video</h2>
        <p className="cinema-note">Search YouTube and pick what the room plays — a lecture, a documentary, a film. Your choice lands in the form below.</p>
        <label className="cinema-search">
          <Search size={16} aria-hidden />
          <input
            value={query}
            onChange={(event) => searchFor(event.target.value)}
            placeholder="Search YouTube…"
            aria-label="Search YouTube for a video"
          />
          {search.busy && <span className="cinema-search-busy" role="status">Searching…</span>}
        </label>
        {search.error && <p className="cinema-error">{search.error}</p>}
        {results.length > 0 && <ul className="cinema-search-results">
          {results.map((result) => <li key={result.videoId}>
            <button type="button" onClick={() => pick(result)} aria-label={`Use ${result.title}`}>
              {result.thumbnail
                ? <img src={result.thumbnail} alt="" loading="lazy" />
                : <span className="cinema-search-blank" aria-hidden><Clapperboard size={16} /></span>}
              <span>
                <strong>{result.title}</strong>
                {result.channel && <small>{result.channel}</small>}
              </span>
            </button>
          </li>)}
        </ul>}
        {search.done && !search.busy && !search.error && !results.length && <p className="cinema-note">
          Nothing came back for &ldquo;{query.trim()}&rdquo;. Try other words, or paste a link in the form below.
        </p>}
        {picked && <p className="cinema-note cinema-sub">Picked <strong>{picked.title}</strong>. Give the room a name below and open it.</p>}
      </section>
      <section className="cinema-card">
        <h2>Start a room</h2>
        <p className="cinema-note">
          Attach a YouTube link to watch together, or play a file of your own. A file makes the room invite-only: it is stored privately and only your guest list can watch it.
        </p>
        <div className="cinema-create">
          <label>Room name
            <input value={title} maxLength={80} placeholder="PHY 201 — revision" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="cinema-choice" role="radiogroup" aria-label="Where the video comes from">
            <button type="button" role="radio" aria-checked={source === "YOUTUBE"} className={source === "YOUTUBE" ? "is-on" : ""} onClick={() => setSource("YOUTUBE")}>
              <Link2 size={15} aria-hidden /> YouTube link
            </button>
            <button type="button" role="radio" aria-checked={source === "UPLOAD"} className={source === "UPLOAD" ? "is-on" : ""} onClick={() => setSource("UPLOAD")}>
              <Upload size={15} aria-hidden /> Play a file
            </button>
          </div>
          {source === "YOUTUBE"
            ? <label>YouTube link
              <input value={video} placeholder="https://youtu.be/…" onChange={(event) => setVideo(event.target.value)} />
            </label>
            : <p className="cinema-note">Choose the file on the next step: MP4, MOV or WebM, up to the size this deployment accepts. It uploads here while the room waits.</p>}
          <div className="cinema-choice" role="radiogroup" aria-label="Who can join">
            <button
              type="button"
              role="radio"
              aria-checked={!createsPrivate}
              className={!createsPrivate ? "is-on" : ""}
              disabled={source === "UPLOAD"}
              onClick={() => setDoor("PUBLIC")}
            ><Globe size={15} aria-hidden /> Anyone with the link</button>
            <button
              type="button"
              role="radio"
              aria-checked={createsPrivate}
              className={createsPrivate ? "is-on" : ""}
              onClick={() => setDoor("PRIVATE")}
            ><Lock size={15} aria-hidden /> Invite only</button>
          </div>
          {source === "UPLOAD" && <p className="cinema-note">A file makes the room private automatically: an upload is the host&apos;s own copy, and the guest list is the only door.</p>}
          <div className="cinema-clock">
            <label>Starts
              <select value={startIn} onChange={(event) => setStartIn(event.target.value)}>
                <option value="0">Straight away</option>
                <option value="15">In 15 minutes</option>
                <option value="30">In 30 minutes</option>
                <option value="60">In 1 hour</option>
                <option value="120">In 2 hours</option>
              </select>
            </label>
            <label>Runs for
              <select value={runsFor} onChange={(event) => setRunsFor(event.target.value)}>
                <option value="0">Until I end it</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="90">90 minutes</option>
                <option value="120">2 hours</option>
                <option value="180">3 hours</option>
              </select>
            </label>
          </div>
          <p className="cinema-note">
            {Number(startIn) > 0
              ? "The room opens by itself at that minute: it goes live and the video starts on every screen that is waiting."
              : "The room is live the moment you create it, and the video starts as soon as it is ready."}
            {Number(runsFor) > 0 ? " It ends by itself when the run time is up." : " You end it when you are done."}
          </p>
          {error && <p className="cinema-error">{error}</p>}
          <button disabled={busy || (source === "YOUTUBE" && !video.trim())} onClick={() => void create()}>
            {busy ? "One moment…" : source === "UPLOAD" ? "Create the room" : Number(startIn) > 0 ? "Schedule the room" : "Open the room"}
          </button>
        </div>
      </section>
      </>}

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
              <small>{room.isHost ? "You host this" : room.isMember ? "You are in this room" : room.invited ? "You are invited" : `Hosted by ${room.hostName}`} · {room.verifiedCount} {room.verifiedCount === 1 ? "person" : "people"}</small>
            </div>
            <div className="cinema-room-tags">
              {room.isPrivate && <span className="cinema-chip is-private"><Lock size={11} aria-hidden /> Private</span>}
              <span className={`cinema-chip${room.status === "LIVE" ? " is-live" : room.status === "ENDED" ? " is-ended" : ""}`}>
                {room.status === "CREATED" && room.startsAt ? `Starts ${clockCopy(room.startsAt)}` : room.status}
              </span>
              {room.isHost && isActive(room) && <button
                type="button"
                className="cinema-chip is-button"
                disabled={roomBusy === room.id}
                title={room.isPrivate ? "Make this room public" : "Make this room invite-only"}
                onClick={() => void flipDoor(room)}
              >{room.isPrivate ? <Globe size={11} aria-hidden /> : <Lock size={11} aria-hidden />}{room.isPrivate ? "Make it public" : "Make it private"}</button>}
              {room.isHost && isActive(room) && !room.videoId && <button
                type="button"
                className="cinema-chip is-button is-upload"
                onClick={() => { setError(""); setUploadRoom(room); }}
              ><Upload size={11} aria-hidden /> Add the file</button>}
            </div>
          </li>)}
        </ul>}
      {listError && <p className="cinema-error cinema-sub">{listError}</p>}
    </aside>
  </div>;
}

/** A room id out of a pasted link, a bare id, or nothing. */
function roomIdFrom(value: string) {
  const trimmed = value.trim().split(/[?#]/)[0];
  const candidate = trimmed.includes("/") ? trimmed.split("/").filter(Boolean).pop() || "" : trimmed;
  return /^[A-Za-z0-9-]{8,64}$/.test(candidate) ? candidate : "";
}

/** A schedule instant on the reader's own clock, e.g. "19:05"; '' when absent. */
function clockCopy(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
