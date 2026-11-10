"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDots, Clock, FilmSlate, Globe, LinkSimple, Lock, MagnifyingGlass, UploadSimple } from "@/components/ui/MaterialIcon";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { StudentAccount } from "@/lib/student-auth";
import type { CinemaRoom } from "@/lib/cinema-engine/rooms";
import type { YouTubeSearchResult } from "@/lib/cinema-engine/youtube";
import { validStudentEmail } from "@/lib/student-email";
import { CinemaDialog } from "./CinemaDialog";
import { UploadPanel } from "./UploadPanel";
import { CinemaReuseButton } from "./CinemaReuseButton";
import type { ReusableCinemaRoom } from "@/lib/cinema-engine/reusable-rooms";
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
 * may walk in. An upload runs here beside the room it fills. A host who changes
 * their mind about the door does it from the room list below; the room itself
 * carries neither control.
 *
 * Creating a room needs an account because a room has a host and a membership
 * row; watching the lobby list needs the same account for the same reason. The
 * shared link is the only thing a signed-out visitor can hold, so pasting one
 * sends them through sign-in and back.
 */
export function CinemaLobby() {
  const { ready, account } = useStudentAccount();
  return <CinemaAccountLobby key={`${account?.id || "anonymous"}:${Boolean(account?.emailVerified)}`} ready={ready} account={account} />;
}

/** Account changes discard every room snapshot, dialog and pending draft. */
function CinemaAccountLobby({ ready, account }: { ready: boolean; account: StudentAccount | null }) {
  const router = useRouter();
  const canHost = Boolean(account && validStudentEmail(account.email));
  const [dialog, setDialog] = useState<"" | "create" | "join">("");
  const [filter, setFilter] = useState("CURRENT");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [publicRoom, setPublicRoom] = useState<CinemaRoom | null>(null);
  const loadSequence = useRef(0);
  const [title, setTitle] = useState("");
  const [video, setVideo] = useState("");
  const [source, setSource] = useState<CinemaSource>("YOUTUBE");
  const [door, setDoor] = useState<CinemaDoor>("PUBLIC");
  const [startMode, setStartMode] = useState<"NOW" | "LATER">("NOW");
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleNow, setScheduleNow] = useState(0);
  /** The host's run time in minutes; 0 means only the host ends the room. */
  const [runsFor, setRunsFor] = useState("0");
  const [link, setLink] = useState("");
  const [rooms, setRooms] = useState<CinemaRoom[]>([]);
  const [savedRooms, setSavedRooms] = useState<ReusableCinemaRoom[]>([]);
  const [editing, setEditing] = useState<{ id: string; sessionId: string; title: string; visibility: CinemaDoor; saved: boolean; status: string } | null>(null);
  const [deleting, setDeleting] = useState<{ sessionId: string; title: string; status: string } | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDoor, setEditDoor] = useState<CinemaDoor>("PRIVATE");
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
    const sequence = ++loadSequence.current;
    setLoading(true); setListError("");
    try {
      const response = await fetch(`/api/cinema/sessions?offset=${offset}&status=${filter}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { rooms?: CinemaRoom[]; hasMore?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "Your rooms could not be loaded.");
      if (sequence !== loadSequence.current) return;
      setRooms(data.rooms || []); setHasMore(data.hasMore === true);
    } catch (error) {
      if (sequence === loadSequence.current) setListError(error instanceof Error ? error.message : "Your rooms could not be loaded.");
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [offset, filter]);

  useEffect(() => { if (account) queueMicrotask(load); }, [account, load]);
  const loadSaved = useCallback(async () => {
    if (!canHost) return;
    const response = await fetch("/api/cinema/reusable-rooms", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Reusable rooms could not be loaded.");
    const data = await response.json() as { rooms?: ReusableCinemaRoom[] };
    setSavedRooms(data.rooms || []);
  }, [canHost]);
  useEffect(() => { if (canHost) queueMicrotask(() => void loadSaved().catch(() => undefined)); }, [canHost, loadSaved]);

  const beginEdit = (room: { id: string; sessionId: string; title: string; visibility: CinemaDoor; saved: boolean; status: string }) => {
    setEditing(room); setEditTitle(room.title); setEditDoor(room.visibility); setListError("");
  };
  const saveEdit = async () => {
    if (!editing) return;
    const trimmed = editTitle.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > 80) { setListError("Enter a room name of up to 80 characters."); return; }
    setRoomBusy(editing.sessionId); setListError("");
    try {
      if (editing.saved) {
        const response = await fetch(`/api/cinema/reusable-rooms/${editing.id}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: trimmed, visibility: editDoor }) });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error || "The room could not be updated.");
      } else {
        for (const change of [{ action: "RETITLE", title: trimmed }, ...(editDoor !== editing.visibility ? [{ action: editDoor }] : [])]) {
          const response = await fetch(`/api/cinema/sessions/${editing.sessionId}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
          const data = await response.json() as { error?: string };
          if (!response.ok) throw new Error(data.error || "The room could not be updated.");
        }
      }
      setEditing(null);
      await Promise.all([load(), loadSaved()]);
    } catch (problem) { setListError(problem instanceof Error ? problem.message : "The room could not be updated."); }
    finally { setRoomBusy(""); }
  };
  const deleteChosen = async () => {
    if (!deleting) return;
    setRoomBusy(deleting.sessionId); setListError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${deleting.sessionId}`, { method: "DELETE", credentials: "same-origin" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The room could not be deleted.");
      setDeleting(null);
      setRooms(current => current.filter(room => room.id !== deleting.sessionId));
      setSavedRooms(current => current.filter(room => room.currentSessionId !== deleting.sessionId));
      await Promise.all([load(), loadSaved()]);
    } catch (problem) { setListError(problem instanceof Error ? problem.message : "The room could not be deleted."); }
    finally { setRoomBusy(""); }
  };

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
    if (!account || dialog !== "create" || source !== "YOUTUBE" || text.length < 2) return;
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
  }, [account, query, dialog, source]);

  /** The tray's one job: put the video in the form below and let the host name the room. */
  const pick = (result: YouTubeSearchResult) => {
    setPicked(result);
    setVideo(`https://www.youtube.com/watch?v=${result.videoId}`);
    setSource("YOUTUBE");
    if (!title.trim()) setTitle(result.title.slice(0, 80));
    setResults([]);
    setSearch({ busy: false, error: "", done: false });
  };

  const createsPrivate = door === "PRIVATE";
  const isActive = (room: CinemaRoom) => room.status === "CREATED" || room.status === "LIVE";

  const create = async () => {
    let startInMinutes = 0;
    if (startMode === "LATER") {
      const target = new Date(`${scheduleDate}T${scheduleTime}`);
      startInMinutes = Math.ceil((target.getTime() - Date.now()) / 60_000);
      if (!scheduleDate || !scheduleTime || !Number.isFinite(target.getTime()) || startInMinutes < 1 || startInMinutes > 7 * 24 * 60) {
        setError("Choose a future date and time within the next seven days.");
        return;
      }
    }
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
          startInMinutes,
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

  const scheduleDays = Array.from({ length: 8 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    return { value: localDate(date), label: index === 0 ? "Today" : index === 1 ? "Tomorrow" : date.toLocaleDateString([], { weekday: "short" }), day: date.getDate() };
  });
  const scheduledPreview = startMode === "LATER" && scheduleDate && scheduleTime
    ? new Date(`${scheduleDate}T${scheduleTime}`) : null;
  const schedulePreviewValid = scheduledPreview && !Number.isNaN(scheduledPreview.getTime())
    && scheduledPreview.getTime() > scheduleNow && scheduledPreview.getTime() <= scheduleNow + 7 * 24 * 60 * 60_000;

  function chooseSchedule() {
    if (!scheduleDate || !scheduleTime) {
      const next = new Date(Date.now() + 60 * 60_000);
      next.setMinutes(0, 0, 0);
      setScheduleDate(localDate(next));
      setScheduleTime(localTime(next));
    }
    setScheduleNow(Date.now());
    setStartMode("LATER");
    setError("");
  }

  if (!ready) return <section className="cinema-card"><p className="cinema-note">Checking your account…</p></section>;

  if (!account) return <section className="cinema-card">
    <h2>Sign in to open a room</h2>
    <p className="cinema-note">Watch public video events and panel discussions with any verified account. UMaT students can also create private rooms.</p>
    <div className="cinema-controls cinema-sub">
      <Link className="cinema-cta" href="/account?next=%2Fcinema%2Frooms">Sign in <FilmSlate size={16} /></Link>
      <Link className="cinema-cta" href="/cinema/events">Browse video events</Link>
    </div>
  </section>;

  if (!account.emailVerified) return <section className="cinema-card">
    <h2>Verify your email to use Cinema</h2>
    <p className="cinema-note">You are signed in as {account.email}. Confirm your email to open or join rooms.</p>
    <Link className="cinema-cta cinema-sub" href="/account?next=%2Fcinema%2Frooms">Verify your email</Link>
  </section>;

  const savedSessionIds = new Set(savedRooms.map(room => room.currentSessionId));
  const visibleRooms = rooms.filter(room => !savedSessionIds.has(room.id));
  const visibleSaved = savedRooms.filter(room => filter === "CURRENT" || !filter
    || filter === "LIVE" && room.currentStatus === "LIVE"
    || filter === "SCHEDULED" && room.currentStatus === "CREATED"
    || filter === "RECENT" && !["LIVE", "CREATED"].includes(room.currentStatus));

  return <div className="cinema-lobby">
    <section className="cinema-lobby-head">
      <div><span className="cinema-eyebrow">YOUR WATCH SPACE</span><h2>Make room for a good conversation.</h2><p>Bring your group together around a video. Keep the same invitation link for future sessions.</p></div>
      <div className="cinema-controls">{canHost && <button className="cinema-cta" onClick={() => { setError(""); setDialog("create"); }}>Create a room</button>}<button className="secondary" onClick={() => { setError(""); setDialog("join"); }}>Join with a link</button></div>
    </section>
    <CinemaDialog open={Boolean(publicRoom)} title="Make this room public?" busy={Boolean(roomBusy)} onClose={() => setPublicRoom(null)}>
      <p>Any signed-in account with a verified email and the link will be able to join {publicRoom?.title}.</p>
      <div className="cinema-controls"><button disabled={Boolean(roomBusy)} onClick={() => { if (publicRoom) void flipDoor(publicRoom).then(() => setPublicRoom(null)); }}>Make public</button><button className="secondary" onClick={() => setPublicRoom(null)}>Keep private</button></div>
    </CinemaDialog>
    <CinemaDialog open={(dialog === "create" && canHost) || Boolean(uploadRoom)} title={uploadRoom ? "Build your playlist" : "Create a room"} busy={busy} onClose={() => { setDialog(""); setUploadRoom(null); void load(); }}>

    {uploadRoom
      ? <section className="cinema-card cinema-file-setup">
        <ol className="cinema-file-steps" aria-label="File room setup"><li className="is-complete">Room ready</li><li aria-current="step">Add videos</li><li>Open &amp; share</li></ol>
        <h2>Build your playlist</h2>
        <p className="cinema-note">
          Add videos to <strong>{uploadRoom.title}</strong> in playback order. The room is {uploadRoom.isPrivate ? "invite-only" : "open to verified accounts with the link"}.
        </p>
        <UploadPanel
          roomId={uploadRoom.id}
          isPrivate={uploadRoom.isPrivate}
          onUploaded={() => { void load(); }}
        />
        <button type="button" className="cinema-cta cinema-file-open" onClick={() => router.push(`/cinema/${uploadRoom.id}`)}>Open room and share link</button>
        <p className="cinema-note cinema-sub">
          No file right now?{" "}
          <button type="button" className="cinema-text-button" onClick={() => router.push(`/cinema/${uploadRoom.id}`)}>Open the room without it</button>
          {" "}— you can add the file from this lobby later.{" "}
          <button type="button" className="cinema-text-button" onClick={() => setUploadRoom(null)}>Start a different room</button>.
        </p>
      </section>
      : <>
      {source === "YOUTUBE" && <section className="cinema-card cinema-search-card">
        <h2>Find a video</h2>
        <p className="cinema-note">Search YouTube or paste a video link below.</p>
        <label className="cinema-search">
          <MagnifyingGlass size={16} aria-hidden />
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
                : <span className="cinema-search-blank" aria-hidden><FilmSlate size={16} /></span>}
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
      </section>}
      <section className="cinema-card cinema-create-panel">
        <h2>Room setup</h2>
        <p className="cinema-note">Choose what to watch, who can join and when playback starts.</p>
        <div className="cinema-create cinema-create-form">
          <label>Room name
            <input value={title} maxLength={80} placeholder="PHY 201 — revision" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="cinema-choice" role="radiogroup" aria-label="Where the video comes from">
            <button type="button" role="radio" aria-checked={source === "YOUTUBE"} className={source === "YOUTUBE" ? "is-on" : ""} onClick={() => setSource("YOUTUBE")}>
              <LinkSimple size={15} aria-hidden /> YouTube link
            </button>
            <button type="button" role="radio" aria-checked={source === "UPLOAD"} className={source === "UPLOAD" ? "is-on" : ""} onClick={() => { setSource("UPLOAD"); setDoor("PRIVATE"); }}>
              <UploadSimple size={15} aria-hidden /> Play a file
            </button>
          </div>
          {source === "YOUTUBE"
            ? <label>YouTube link
              <input value={video} placeholder="https://youtu.be/…" onChange={(event) => setVideo(event.target.value)} />
            </label>
            : <p className="cinema-note">Upload an MP4, MOV or WebM file in the next step. <Link href="/cinema/rooms/plans">Compare room plans</Link> for larger playlists.</p>}
          <div className="cinema-choice" role="radiogroup" aria-label="Who can join">
            <button
              type="button"
              role="radio"
              aria-checked={!createsPrivate}
              className={!createsPrivate ? "is-on" : ""}
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
          {source === "UPLOAD" && <p className="cinema-note">Only upload videos you have the right to share. Public file rooms can be joined by any verified account with the link.</p>}
          <section className="cinema-create-schedule" aria-label="Room schedule">
            <div className="cinema-create-section-heading"><CalendarDots size={19} aria-hidden /><div><strong>When should it start?</strong><small>Set a time now or plan up to seven days ahead.</small></div></div>
            <div className="cinema-create-start-choice" role="radiogroup" aria-label="Room start time">
              <button type="button" role="radio" aria-checked={startMode === "NOW"} className={startMode === "NOW" ? "is-on" : ""} onClick={() => { setStartMode("NOW"); setError(""); }}><Clock size={17} aria-hidden /> Start now</button>
              <button type="button" role="radio" aria-checked={startMode === "LATER"} className={startMode === "LATER" ? "is-on" : ""} onClick={chooseSchedule}><CalendarDots size={17} aria-hidden /> Pick a date</button>
            </div>
            {startMode === "LATER" && <div className="cinema-date-picker">
              <div className="cinema-date-strip" aria-label="Choose a day; swipe to see more dates">
                {scheduleDays.map(day => <button key={day.value} type="button" aria-pressed={scheduleDate === day.value} onClick={() => { setScheduleDate(day.value); setScheduleNow(Date.now()); setError(""); }}><span>{day.label}</span><strong>{day.day}</strong></button>)}
              </div>
              <div className="cinema-date-fields"><label>Date<input type="date" required min={scheduleDays[0].value} max={scheduleDays[7].value} value={scheduleDate} onChange={event => { setScheduleDate(event.target.value); setScheduleNow(Date.now()); setError(""); }} /></label><label>Time<input type="time" required step="60" value={scheduleTime} onChange={event => { setScheduleTime(event.target.value); setScheduleNow(Date.now()); setError(""); }} /></label></div>
              <small>Times use your device’s local time zone. Swipe the days to browse.</small>
            </div>}
          </section>
          <section className="cinema-create-duration"><div className="cinema-create-section-heading"><Clock size={19} aria-hidden /><div><strong>How long?</strong><small>A fixed end time closes the room automatically.</small></div></div>
            <label>Room duration<select value={runsFor} onChange={(event) => setRunsFor(event.target.value)}>
              <option value="0">Until I end it</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="90">90 minutes</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option>{source === "UPLOAD" && <option value="300">5 hours (Pro)</option>}
            </select></label>
          </section>
          <p className={`cinema-schedule-summary${startMode === "LATER" && !schedulePreviewValid ? " is-invalid" : ""}`} role="status"><CalendarDots size={17} aria-hidden /><span>{startMode === "LATER" ? schedulePreviewValid ? `Scheduled for ${scheduledPreview.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : "Choose a future date and time within seven days." : source === "UPLOAD" ? "Room opens now; playback starts when your file is ready." : "Starts as soon as you create it."} {Number(runsFor) > 0 ? `Ends after ${Number(runsFor) < 60 ? `${runsFor} minutes` : `${Number(runsFor) / 60} hours`}.` : source === "UPLOAD" ? "Your plan's safety limit still applies once playback begins." : "You decide when to end it."}</span></p>
          {error && <p className="cinema-error">{error}</p>}
          <button disabled={busy || (source === "YOUTUBE" && !video.trim())} onClick={() => void create()}>
            {busy ? "One moment…" : startMode === "LATER" ? "Schedule the room" : source === "UPLOAD" ? "Create the room" : "Open the room"}
          </button>
        </div>
      </section>
      </>}

    </CinemaDialog>
    <CinemaDialog open={dialog === "join"} title="Join a room" onClose={() => setDialog("")}>
      <p className="cinema-note">Paste the invitation link your host shared.</p>
      <div className="cinema-create">
        <label>Room link
          <input value={link} placeholder="/cinema/… or the full link" onChange={(event) => setLink(event.target.value)} />
        </label>
        <button disabled={!link.trim()} onClick={open}>Go to the room</button>
      </div>

      {error && <p className="cinema-error" role="alert">{error}</p>}
    </CinemaDialog>
    <CinemaDialog open={Boolean(editing)} title="Edit room" busy={Boolean(roomBusy)} onClose={() => { setEditing(null); setListError(""); }}>
      <div className="cinema-create cinema-room-edit"><label>Room name<input value={editTitle} maxLength={80} onChange={event => setEditTitle(event.target.value)} /></label><fieldset><legend>Who can join?</legend><label><input type="radio" name="edit-room-door" checked={editDoor === "PUBLIC"} onChange={() => setEditDoor("PUBLIC")} /> Anyone with the link</label><label><input type="radio" name="edit-room-door" checked={editDoor === "PRIVATE"} onChange={() => setEditDoor("PRIVATE")} /> Invite only</label></fieldset>{listError && <p className="cinema-error" role="alert">{listError}</p>}<div className="cinema-controls"><button type="button" disabled={Boolean(roomBusy) || !editTitle.trim()} onClick={() => void saveEdit()}>{roomBusy ? "Saving…" : "Save changes"}</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button></div></div>
    </CinemaDialog>
    <CinemaDialog open={Boolean(deleting)} title="Delete this room?" busy={Boolean(roomBusy)} onClose={() => { setDeleting(null); setListError(""); }}>
      <p><strong>{deleting?.title}</strong> will disappear from room lists. Its invitation link and uploaded files will be removed. If it is live, the session will end for everyone.</p>{listError && <p className="cinema-error" role="alert">{listError}</p>}<div className="cinema-controls"><button type="button" className="danger" disabled={Boolean(roomBusy)} onClick={() => void deleteChosen()}>{roomBusy ? "Deleting…" : "Delete room"}</button><button type="button" className="secondary" onClick={() => setDeleting(null)}>Keep room</button></div>
    </CinemaDialog>
    <section className="cinema-card cinema-room-list">
      <div className="cinema-list-heading"><div><h2>Your rooms</h2><p className="cinema-note">Current rooms and reusable links appear once. Open Recent to see past sessions.</p><Link className="cinema-plan-inline-link" href="/cinema/rooms/plans">View room plans and your allowance</Link></div><button className="cinema-text-button" disabled={loading} onClick={() => { void load(); void loadSaved().catch(() => undefined); }}>Refresh</button></div>
      <nav className="cinema-filters" aria-label="Filter your rooms">{[['CURRENT', 'Current'], ['LIVE', 'Live'], ['SCHEDULED', 'Scheduled'], ['RECENT', 'Recent']].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setOffset(0); setFilter(value); }}>{label}</button>)}</nav>
      {listError && !editing && !deleting && <div className="cinema-error" role="alert">{listError} <button onClick={() => { void load(); void loadSaved().catch(() => undefined); }}>Retry</button></div>}
      {loading ? <p className="cinema-note" role="status">Loading your rooms…</p> : !visibleSaved.length && !visibleRooms.length
        ? <div className="cinema-room-empty"><FilmSlate size={28} aria-hidden /><h3>{filter === "RECENT" ? "No past sessions yet" : filter === "LIVE" ? "No rooms are live" : filter === "SCHEDULED" ? "Nothing scheduled yet" : "Your watch rooms will appear here"}</h3><p>{filter === "RECENT" ? "Finished sessions appear here after you use a room." : "Create a room for your group, or open an invitation link from a host."}</p><div>{filter !== "CURRENT" && <button type="button" className="secondary" onClick={() => setFilter("CURRENT")}>See current rooms</button>}{canHost && <button type="button" onClick={() => { setError(""); setDialog("create"); }}>Create a room</button>}<button type="button" className="secondary" onClick={() => { setError(""); setDialog("join"); }}>Join with a link</button></div></div>
        : <ul className="cinema-rooms">
          {visibleSaved.map(saved => <li className="cinema-room-row is-saved" key={`saved-${saved.id}`}><div className="cinema-room-info"><div className="cinema-room-tags"><span className="cinema-chip">{saved.currentStatus === "LIVE" ? "Live now" : saved.currentStatus === "CREATED" ? "Scheduled" : "Ready to reuse"}</span><span className="cinema-chip">Reusable link</span>{saved.visibility === "PRIVATE" && <span className="cinema-chip is-private">Invite only</span>}</div><h3><Link href={`/cinema/${saved.id}`}>{saved.title}</Link></h3><p>{saved.sourceType === "UPLOAD" ? "File room" : "YouTube room"} · same invitation link each session</p></div><div className="cinema-room-actions">{saved.currentStatus === "LIVE" || saved.currentStatus === "CREATED" ? <Link className="cinema-room-open" href={`/cinema/${saved.id}`}>Open room</Link> : <CinemaReuseButton stableId={saved.id} onStarted={() => { void load(); void loadSaved().catch(() => undefined); }} />}<button type="button" className="cinema-chip is-button" disabled={roomBusy === saved.currentSessionId} onClick={() => beginEdit({ id: saved.id, sessionId: saved.currentSessionId, title: saved.title, visibility: saved.visibility, saved: true, status: saved.currentStatus })}>Edit</button><button type="button" className="cinema-chip is-button is-delete" disabled={roomBusy === saved.currentSessionId} onClick={() => setDeleting({ sessionId: saved.currentSessionId, title: saved.title, status: saved.currentStatus })}>Delete</button></div></li>)}
          {visibleRooms.map((room) => {
            const thumbnail = room.sourceType === "YOUTUBE" && /^[A-Za-z0-9_-]{11}$/.test(room.videoId)
              ? `https://i.ytimg.com/vi/${room.videoId}/hqdefault.jpg`
              : room.sourceType === "UPLOAD" && room.videoId
                ? `/api/cinema/sessions/${room.id}/thumbnail?uploadId=${encodeURIComponent(room.videoId)}` : "";
            const status = room.status === "CREATED" ? "Scheduled" : room.status === "LIVE" ? "Live now" : "Ended";
            return <li className="cinema-room-row" key={room.id}>
              <Link className="cinema-room-poster" href={`/cinema/${room.id}`} aria-label={`Open ${room.title}`}>
                <FilmSlate size={28} aria-hidden />
                {thumbnail && <img src={thumbnail} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
              </Link>
              <div className="cinema-room-info">
                <div className="cinema-room-tags">
                  <span className={`cinema-chip${room.status === "LIVE" ? " is-live" : room.status !== "CREATED" ? " is-ended" : " is-scheduled"}`}>{status}</span>
                  {room.isPrivate && <span className="cinema-chip is-private"><Lock size={11} aria-hidden /> Invite only</span>}
                </div>
                <h3><Link href={`/cinema/${room.id}`}>{room.title}</Link></h3>
                <p>{room.isHost ? "Hosted by you" : `Hosted by ${room.hostName}`} · {room.verifiedCount} {room.verifiedCount === 1 ? "participant" : "participants"}</p>
                {room.status === "CREATED" && room.startsAt && <time dateTime={room.startsAt}>Starts {sessionDateCopy(room.startsAt)}</time>}
              </div>
              <div className="cinema-room-actions">
                <Link className="cinema-room-open" href={`/cinema/${room.id}`}>{isActive(room) ? "Open room" : "View room"}</Link>
                {room.isHost && isActive(room) && <button
                  type="button"
                  className="cinema-chip is-button"
                  disabled={roomBusy === room.id}
                  title={room.isPrivate ? "Make this room public" : "Make this room invite-only"}
                  onClick={() => room.isPrivate ? setPublicRoom(room) : void flipDoor(room)}
                >{room.isPrivate ? <Globe size={11} aria-hidden /> : <Lock size={11} aria-hidden />}{room.isPrivate ? "Make public" : "Make private"}</button>}
                {room.isHost && room.sourceType === "UPLOAD" && isActive(room) && <button
                  type="button"
                  className="cinema-chip is-button is-upload"
                  onClick={() => { setError(""); setUploadRoom(room); }}
                ><UploadSimple size={11} aria-hidden /> Manage playlist</button>}
                {room.isHost && room.status !== "EXPIRED" && <button type="button" className="cinema-chip is-button" onClick={() => beginEdit({ id: room.id, sessionId: room.id, title: room.title, visibility: room.visibility, saved: false, status: room.status })}>Edit</button>}
                {room.isHost && <button type="button" className="cinema-chip is-button is-delete" onClick={() => setDeleting({ sessionId: room.id, title: room.title, status: room.status })}>Delete</button>}
              </div>
            </li>;
          })}
        </ul>}
      {(hasMore || offset > 0) && <nav className="cinema-pagination" aria-label="Room pages"><button disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous</button><span>Page {Math.floor(offset / 20) + 1}</span><button disabled={!hasMore || loading} onClick={() => setOffset(value => value + 20)}>Next</button></nav>}
    </section>
  </div>;
}

/** A room id out of a pasted link, a bare id, or nothing. */
function roomIdFrom(value: string) {
  const trimmed = value.trim().split(/[?#]/)[0];
  const candidate = trimmed.includes("/") ? trimmed.split("/").filter(Boolean).pop() || "" : trimmed;
  return /^[A-Za-z0-9-]{8,64}$/.test(candidate) ? candidate : "";
}

function sessionDateCopy(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Time to be confirmed";
  return at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
