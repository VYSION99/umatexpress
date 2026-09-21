"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Flag, Lock, LockOpen, Mail, MessagesSquare, MicOff, NotebookPen, Play, Radio, Send, Sparkles, Square, Timer, UserPlus, X,
} from "lucide-react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom as Room } from "@/lib/cinema-engine/rooms";
import { expectedPosition } from "@/lib/cinema-engine/sync";
import { useCinemaSocket } from "./useCinemaSocket";
import { CinemaCallButtons } from "./CinemaCallButtons";
import { CinemaInvites } from "./CinemaInvites";
import { CinemaMediaStrip } from "./CinemaMediaStrip";
import { CinemaNotes } from "./CinemaNotes";
import { CinemaRecorderPanel } from "./CinemaRecorderPanel";
import { CinemaWhiteboardPanel } from "./CinemaWhiteboardPanel";
import { UploadPlayer } from "./UploadPlayer";
import { YouTubePlayer } from "./YouTubePlayer";
import { useCinemaMedia } from "./useCinemaMedia";
import { useCinemaRecorder } from "./useCinemaRecorder";
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
 *
 * The two choices a room is made of — where its video comes from and who may
 * walk in — are made in the lobby before the room opens, so this page shows
 * them rather than offering them: no upload, no door switch. A host changes
 * either from the Cinema lobby, where the room list carries both.
 *
 * On a phone the room is the video first: a floating rail at the top right
 * holds the call's buttons (mic, camera, recorder) and opens one panel at a
 * time as a bottom sheet, and a Zoom-shaped dock holds who is here and the
 * host's actions at the bottom. The call and the recorder are owned here
 * rather than inside a panel, because a panel that unmounted would take them
 * with it — the mic can be muted, and a take kept running, with no card open.
 */
type CinemaSheet = "" | "board" | "notes" | "record" | "invite" | "chat" | "people";

/** A room notice that is worth interrupting a video for: an automatic board. */
type CinemaToast = { id: string; title: string; body: string };

/** How long a toast stays before it folds itself away, in milliseconds. */
const TOAST_MS = 15_000;
/** At most this many toasts stack; the newest pushes the oldest out. */
const TOAST_KEEP = 3;

export function CinemaRoom({ initialRoom }: { initialRoom: Room }) {
  const { ready, account } = useStudentAccount();
  const [room, setRoom] = useState<Room>(initialRoom);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<{ messageId?: string; video?: boolean; label: string } | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportNotice, setReportNotice] = useState("");
  const [sheet, setSheet] = useState<CinemaSheet>("");
  /** Set for a moment after a mute-all goes out, so the host sees the ask land. */
  const [muteSent, setMuteSent] = useState(false);
  /** Automatic-board notices; the room's summaries arrive here, not in a panel. */
  const [toasts, setToasts] = useState<CinemaToast[]>([]);
  const joined = useRef(false);
  const chatEndRef = useRef<HTMLLIElement | null>(null);
  const muteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const enteredStatus = useRef(initialRoom.status);
  const active = room.status === "CREATED" || room.status === "LIVE";
  // The socket is the room's live voice: it opens once the page knows who the
  // student is, and closes the moment the room stops being open.
  const live = useCinemaSocket({ roomId: room.id, enabled: Boolean(ready && account && active) });
  // The row is the record and a socket that connects later reads it from the
  // snapshot; a socket already in the room learns about a finished upload from
  // the `source` frame, which is what switches the player without a reload.
  const sourceType = live.source?.sourceType ?? room.sourceType;
  const videoId = live.source?.videoId ?? room.videoId;
  const openSheet = (next: CinemaSheet) => setSheet((current) => (current === next ? "" : next));
  const closeSheet = useCallback(() => setSheet(""), []);

  // The call belongs to the room, not to a card: the strip draws the pictures
  // and the call buttons in the rail and beside the strip work the switches,
  // and a second copy of this hook would open a second call. They receive it.
  const roomMember = account && active && live.members.length > 0 ? account : null;
  const media = useCinemaMedia({
    roomId: room.id,
    enabled: Boolean(roomMember && live.state === "live"),
    selfId: roomMember?.id ?? "",
    members: live.members,
    send: live.send,
    subscribeSignals: live.subscribeSignals,
    muteAllSignal: live.muteAllSignal,
  });
  // The recorder belongs to the room for the same reason the call does: its
  // card may open and close, but a take in flight must not go with it.
  const recorder = useCinemaRecorder({
    roomId: room.id,
    enabled: Boolean(roomMember) && live.state === "live" && media.policy.recordings,
    maxMinutes: media.policy.maxRecordingMinutes,
    stream: media.localStream,
    send: live.send,
  });
  const releaseDevices = media.releaseDevices;
  const subscribeBoards = live.subscribeBoards;

  // An ended room releases the microphone and camera: the panel that used to
  // unmount and clean up is no longer the owner of the call.
  useEffect(() => {
    if (!active) releaseDevices();
  }, [active, releaseDevices]);

  /** The host asks the room to mute; each member's browser does the muting. */
  const askMuteAll = () => {
    if (!room.isHost || !active) return;
    live.send({ type: "mute_all" });
    setMuteSent(true);
    if (muteTimer.current) clearTimeout(muteTimer.current);
    muteTimer.current = setTimeout(() => setMuteSent(false), 3200);
  };

  /** The board is a sheet on a phone and a card on a desktop; both are here. */
  const showBoard = () => {
    openSheet("board");
    // On a desktop every panel is already on the page, so "open" means bring
    // it into view; on a phone the sheet comes to the room and the page holds
    // still.
    if (window.matchMedia("(min-width:901px)").matches) {
      document.getElementById("cinema-sheet-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // A pending notice is cleared on the way out; the room may unmount mid-count.
  useEffect(() => () => { if (muteTimer.current) clearTimeout(muteTimer.current); }, []);
  useEffect(() => {
    const timers = toastTimers.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  }, []);

  /** Shows one notice and folds it away on its own; repeated ids only reset it. */
  const pushToast = useCallback((toast: CinemaToast) => {
    setToasts((current) => [...current.filter((item) => item.id !== toast.id), toast].slice(-TOAST_KEEP));
    const pending = toastTimers.current.get(toast.id);
    if (pending) clearTimeout(pending);
    toastTimers.current.set(toast.id, setTimeout(() => {
      toastTimers.current.delete(toast.id);
      setToasts((current) => current.filter((item) => item.id !== toast.id));
    }, TOAST_MS));
  }, []);

  const dismissToast = useCallback((id: string) => {
    const pending = toastTimers.current.get(id);
    if (pending) clearTimeout(pending);
    toastTimers.current.delete(id);
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  // An automatic room answers and summarises through the socket, and a summary
  // nobody opens a panel to read is not a summary. Every new board in an
  // automatic room toasts its own title and two-sentence body.
  useEffect(() => subscribeBoards((board) => {
    if (live.boardPolicy !== "AUTO") return;
    pushToast({ id: board.id, title: board.title, body: board.summary });
  }), [subscribeBoards, pushToast, live.boardPolicy]);

  // A sheet is an overlay on a phone, so the page behind it must hold still and
  // Escape must close it. Neither effect writes React state during a render.
  useEffect(() => {
    if (!sheet) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSheet(""); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [sheet]);

  // A chat that does not follow its own tail is a chat nobody reads.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [live.messages.length]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/cinema/sessions/${initialRoom.id}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
    const data = await response.json() as { room?: Room };
      if (data.room) setRoom(data.room);
    } catch { /* a failed refresh leaves the last known room on screen */ }
  }, [initialRoom.id]);

  // The room's own clock. Only a room still waiting for its minute ticks, and
  // the tick is also what notices the minute arriving: the row is read once so
  // the header stops offering "Open the room" to a room that is already live.
  const startsAtMs = room.startsAt ? Date.parse(room.startsAt) : 0;
  const endsAtMs = room.endsAt ? Date.parse(room.endsAt) : 0;
  const waiting = room.status === "CREATED" && startsAtMs > 0;
  const [clockNow, setClockNow] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    let reloaded = false;
    const tick = () => {
      const now = Date.now();
      setClockNow(now);
      if (!reloaded && startsAtMs <= now) { reloaded = true; void load(); }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [waiting, startsAtMs, load]);
  // A playing room is live whatever the last read said: the object started it,
  // and the header should say so without waiting for a reload the student can
  // hear but not see.
  const playbackRunning = Boolean(live.playback?.isPlaying);
  useEffect(() => {
    if (playbackRunning && room.status === "CREATED") queueMicrotask(load);
  }, [playbackRunning, room.status, load]);
  const pendingStart = waiting && startsAtMs > clockNow;
  const startsInSeconds = pendingStart && clockNow > 0 ? Math.max(0, Math.ceil((startsAtMs - clockNow) / 1000)) : 0;

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

  const people = peopleOf(room, live);
  const canSeek = room.isHost && live.state === "live" && Boolean(live.playback);

  /** The playhead a message is asking about, or null before the video starts. */
  const chatTimestamp = () => {
    if (!live.playback) return null;
    const at = Math.round(expectedPosition(live.playback, Date.now()));
    return at > 0 ? at : null;
  };

  const seekTo = (seconds: number) => {
    if (!canSeek || !live.playback) return;
    live.send({
      type: "seek",
      time: seconds,
      duration: live.playback.durationSeconds || undefined,
      stateAt: live.playback.updatedAt,
    });
  };

  /** Reports go to the moderation desk; nothing in the room changes. */
  const sendReport = async () => {
    if (!report) return;
    setReportBusy(true);
    try {
      const response = await fetch(`/api/cinema/sessions/${room.id}/report`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: report.messageId, video: report.video, reason: reportReason }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The report could not be sent.");
      setReportNotice("Sent to the moderators. Thank you — nothing in the room changes while they look.");
      setReport(null);
      setReportReason("");
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "The report could not be sent.");
    } finally {
      setReportBusy(false);
    }
  };

  return <div className="cinema-room">
    <nav className="cinema-rail" aria-label="Room features">
      {roomMember && <CinemaCallButtons
        media={media}
        recorder={recorder}
        recordOpen={sheet === "record"}
        onToggleRecord={() => openSheet("record")}
      />}
      {account && <button
        type="button"
        className={sheet === "board" ? "is-active" : ""}
        aria-label="AI whiteboard"
        data-tip="AI whiteboard"
        aria-expanded={sheet === "board"}
        aria-controls="cinema-sheet-board"
        onClick={showBoard}
      ><Sparkles size={18} aria-hidden /></button>}
      <button
        type="button"
        className={sheet === "notes" ? "is-active" : ""}
        aria-label="My notes"
        data-tip="My notes"
        aria-expanded={sheet === "notes"}
        aria-controls="cinema-sheet-notes"
        onClick={() => openSheet("notes")}
      ><NotebookPen size={18} aria-hidden /></button>
      <button
        type="button"
        className={sheet === "invite" ? "is-active" : ""}
        aria-label="Invite"
        data-tip="Invite"
        aria-expanded={sheet === "invite"}
        aria-controls="cinema-sheet-invite"
        onClick={() => openSheet("invite")}
      ><UserPlus size={18} aria-hidden /></button>
      <button
        type="button"
        className={sheet === "chat" ? "is-active" : ""}
        aria-label="Room chat"
        data-tip="Room chat"
        aria-expanded={sheet === "chat"}
        aria-controls="cinema-sheet-chat"
        onClick={() => openSheet("chat")}
      ><MessagesSquare size={18} aria-hidden /></button>
    </nav>
    {sheet && <button type="button" className="cinema-sheet-backdrop" aria-label="Close the open panel" onClick={closeSheet} />}
    <div className="cinema-stage">
      <section className="cinema-video">
        <div className="cinema-video-head">
          <div className="cinema-video-title">
            <strong>{room.title}</strong>
            {room.isPrivate && <span className="cinema-chip is-private"><Lock size={11} aria-hidden /> Private</span>}
            {room.isPrivate && !room.isHost && <span className="cinema-chip is-private"><Mail size={11} aria-hidden /> Invited guest</span>}
            {pendingStart && startsInSeconds > 0 && <span className="cinema-chip is-scheduled"><Timer size={11} aria-hidden /> Starts in {clockTime(startsInSeconds)}</span>}
            {room.status === "LIVE" && endsAtMs > 0 && <span className="cinema-chip is-scheduled"><Timer size={11} aria-hidden /> Runs until {clockCopy(room.endsAt)}</span>}
          </div>
          <span className="cinema-video-hint">
            {active
              ? pendingStart
                ? "The room opens by itself at its minute: it goes live and the video starts on every screen that is waiting. You can take your seat now."
                : "The host's play, pause and seek land on every screen. Anyone in the room can watch; only the host drives."
              : "This room has ended."}
          </span>
        </div>
        {active && sourceType === "YOUTUBE" && videoId
          ? <YouTubePlayer
            videoId={videoId}
            isHost={room.isHost}
            playback={live.playback}
            onAction={live.send}
          />
          : active && sourceType === "UPLOAD" && videoId
            ? <UploadPlayer
              roomId={room.id}
              isHost={room.isHost}
              playback={live.playback}
              onAction={live.send}
            />
            : <p className="cinema-video-closed">
              {active
                ? room.isHost
                  ? "No video is attached yet. Add one from the Cinema lobby — the room picks it up as soon as it is ready."
                  : "No video is attached yet. The host adds it from the Cinema lobby."
                : "This room has ended."}
            </p>}
      </section>

      {roomMember && <CinemaMediaStrip
        media={media}
        members={live.members}
        selfId={roomMember.id}
      />}
      {/* The desktop's control bar, Zoom-shaped: the call, the panels and the
          host's actions in one row at the foot of the stage, with the name
          under every button. It is the only place these live on a wide screen
          — the rail and the dock are the phone's version of the same row — and
          it stays in reach while the sidebar scrolls. */}
      <div className="cinema-toolbar" role="toolbar" aria-label="Room controls">
        {roomMember && <div className="cinema-toolbar-group">
          <CinemaCallButtons
            media={media}
            recorder={recorder}
            recordOpen={sheet === "record"}
            onToggleRecord={() => openSheet("record")}
            labels
          />
        </div>}
        <div className="cinema-toolbar-group">
          {account && <ToolButton label="AI board" active={sheet === "board"} onClick={showBoard}><Sparkles size={18} aria-hidden /></ToolButton>}
          <ToolButton label="Notes" active={sheet === "notes"} onClick={() => openSheet("notes")}><NotebookPen size={18} aria-hidden /></ToolButton>
          <ToolButton label="Invite" active={sheet === "invite"} onClick={() => openSheet("invite")}><UserPlus size={18} aria-hidden /></ToolButton>
          <ToolButton label="Chat" active={sheet === "chat"} onClick={() => openSheet("chat")}><MessagesSquare size={18} aria-hidden /></ToolButton>
        </div>
        {room.isHost && active && <div className="cinema-toolbar-group is-host">
          {room.status === "CREATED" && !pendingStart && <ToolButton label="Open" disabled={Boolean(busy)} onClick={() => void act("OPEN")}><Play size={18} aria-hidden /></ToolButton>}
          {!room.isPrivate && (room.joinLocked
            ? <ToolButton label="Unlock" disabled={Boolean(busy)} onClick={() => void act("UNLOCK")}><LockOpen size={18} aria-hidden /></ToolButton>
            : <ToolButton label="Lock" disabled={Boolean(busy)} onClick={() => void act("LOCK")}><Lock size={18} aria-hidden /></ToolButton>)}
          <ToolButton label="Mute all" active={muteSent} onClick={askMuteAll}><MicOff size={18} aria-hidden /></ToolButton>
          <ToolButton label="End room" danger disabled={Boolean(busy)} onClick={() => void act("END")}><Square size={18} aria-hidden /></ToolButton>
        </div>}
        {muteSent && <span className="cinema-chip is-live" role="status"><MicOff size={11} aria-hidden /> Room asked to mute</span>}
      </div>
      {/* The old Voice & video card is gone; what it had to say that the
          buttons cannot is one line here, where the call's pictures live. */}
      {roomMember && media.error && <p className="cinema-error">{media.error}</p>}
      {roomMember && !media.error && media.policyLoaded && !media.policy.voice && !media.policy.camera && <p className="cinema-note">
        Voice and camera are switched off on this deployment. Chat and the video still work.
      </p>}

      <Sheet open={sheet === "record"} id="cinema-sheet-record" label="Recorder" onClose={closeSheet}>
        {sheet === "record" && roomMember && <CinemaRecorderPanel media={media} recorder={recorder} connected={live.state === "live"} />}
      </Sheet>

      <Sheet open={sheet === "board"} id="cinema-sheet-board" label="AI whiteboard" onClose={closeSheet}>
        {account && <CinemaWhiteboardPanel
          roomId={room.id}
          selfId={account.id}
          isHost={room.isHost}
          active={active}
          connected={live.state === "live"}
          boardPolicy={live.boardPolicy}
          onBoardPolicy={(policy) => live.send({ type: "board_policy", policy })}
          board={live.whiteboard}
          removedIds={live.removedWhiteboards}
          playback={live.playback}
        />}
      </Sheet>

      <Sheet open={sheet === "notes"} id="cinema-sheet-notes" label="My notes" onClose={closeSheet}>
        <CinemaNotes roomId={room.id} />
      </Sheet>

      <Sheet open={sheet === "invite"} id="cinema-sheet-invite" label="Invite" onClose={closeSheet}>
        <section className="cinema-share">
          <strong>Invite</strong>
          <code>{`/cinema/${room.id}`}</code>
          <button onClick={() => void share()}>{copied ? "Link copied" : "Copy the room link"}</button>
        </section>
        {room.isHost && room.isPrivate && <section className="cinema-card cinema-invite-card">
          <CinemaInvites
            roomId={room.id}
            members={room.participants
              .filter((member) => member.studentId !== room.hostStudentId)
              .map((member) => ({ studentId: member.studentId, displayName: member.displayName }))}
            onChanged={() => void load()}
          />
        </section>}
      </Sheet>

      {/* The host's buttons are in the control bar above; this card is what the
          bar cannot say — which door this room has, and where it is changed. */}
      {room.isHost && active && <section className="cinema-card cinema-host-card">
        <h2>Your room</h2>
        <div className="cinema-controls">
          {room.status === "LIVE" && <span className="cinema-chip is-live"><Radio size={12} /> Live</span>}
          {room.joinLocked && !room.isPrivate && <span className="cinema-chip is-private"><Lock size={11} aria-hidden /> Door locked</span>}
        </div>
        <p className="cinema-note cinema-sub">
          {room.isPrivate
            ? "The room is private: only your guest list can read or join it. Manage the list from Invite; removing a guest takes back the invitation and the seat."
            : room.joinLocked
              ? "The door is locked: only students already in can come back in."
              : "Anyone with the link and a UMaT account can join."}
          {" "}The lobby is where the door and the video are chosen.
        </p>
      </section>}

      {error && <p className="cinema-error">{error}</p>}
    </div>

    <aside className="cinema-card cinema-side">
      <Sheet open={sheet === "people"} id="cinema-sheet-people" label="Who's here" onClose={closeSheet}>
      <section className="cinema-side-people">
      <div className="cinema-presence-head">
        <h2>Who&apos;s here</h2>
        {account && <span className={`cinema-link is-${live.state}`}>{connectionCopy(live.state)}</span>}
      </div>
      {!ready
        ? <p className="cinema-note">Checking your account…</p>
        : !account
          ? <>
            <p className="cinema-note">Sign in with your <strong>@st.umat.edu.gh</strong> account to join and appear here.</p>
            <div className="cinema-controls cinema-sub">
              <Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/${room.id}`)}`}>Sign in to join</Link>
            </div>
          </>
          : <>
            <ul className="cinema-people">
              {people.map((member) => <li key={member.studentId}>
                {member.displayName || "Member"}
                <span>{member.isHost ? "Host" : "Member"}</span>
              </li>)}
            </ul>
            {live.state !== "live" && <p className="cinema-note cinema-sub">
              {live.state === "closed"
                ? live.closedReason || "The live connection is closed."
                : "Reconnecting — the list shows the last state the room sent."}
            </p>}
          </>}
      {account && <div className="cinema-controls cinema-sub">
        <button className="secondary" onClick={() => void load()}>Refresh the room</button>
      </div>}
      <p className="cinema-note cinema-sub">
        {room.status === "ENDED"
          ? "This room has ended. Nobody new can join."
          : room.isPrivate
            ? room.isHost
              ? "This room is private. Only your guest list can read it or come in."
              : "You are an invited guest: you can watch, chat, ask the board and use the media, and the host keeps the room's controls."
            : room.joinLocked
              ? "The host locked the door, so only people already in can come back."
              : "Everyone with the link and a UMaT account can join. A name leaves the list when that person closes the room."}
      </p>
      </section>
      </Sheet>

      <Sheet open={sheet === "chat"} id="cinema-sheet-chat" label="Room chat" onClose={closeSheet}>
      <section className="cinema-chat">
        <div className="cinema-presence-head">
          <h2>Room chat</h2>
          {account && live.messages.length > 0 && <span className="cinema-link">{live.messages.length} message{live.messages.length === 1 ? "" : "s"}</span>}
        </div>
        {!account
          ? <p className="cinema-note">Sign in with your <strong>@st.umat.edu.gh</strong> account to read and send messages with the room.</p>
          : <>
            {live.messages.length === 0
              ? <p className="cinema-note">No messages yet. Ask about a moment in the video and the room attaches where you were.</p>
              : <ul className="cinema-messages">
                {live.messages.map((message) => <li key={message.id} className={message.senderId === account.id ? "is-mine" : ""}>
                  <header>
                    <strong>{message.senderId === account.id ? "You" : message.senderName || "Member"}</strong>
                    {message.atSeconds !== null && (canSeek
                      ? <button
                        type="button"
                        className="cinema-timestamp"
                        title="Bring the room to this moment"
                        onClick={() => seekTo(message.atSeconds as number)}
                      >{clockTime(message.atSeconds)}</button>
                      : <span className="cinema-timestamp is-static">{clockTime(message.atSeconds)}</span>)}
                    {message.senderId !== account.id && <button
                      type="button"
                      className="cinema-report-flag"
                      title="Report this message to the moderators"
                      aria-label="Report this message"
                      onClick={() => { setReport({ messageId: message.id, label: "Report a message" }); setReportReason(""); setReportNotice(""); }}
                    ><Flag size={12} aria-hidden /></button>}
                  </header>
                  <p>{message.content}</p>
                </li>)}
                <li ref={chatEndRef} className="cinema-chat-end" aria-hidden />
              </ul>}
            <form
              className="cinema-chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft;
                setDraft("");
                live.sendChat(text, chatTimestamp());
              }}
            >
              <input
                value={draft}
                maxLength={500}
                placeholder={live.state === "live" ? "Ask the room…" : "Chat returns with the connection"}
                aria-label="Message the room"
                disabled={live.state !== "live"}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" aria-label="Send the message" disabled={!draft.trim() || live.state !== "live"}>
                <Send size={15} aria-hidden />
              </button>
            </form>
            <p className="cinema-note cinema-sub">
              {room.isHost
                ? "Tap a timestamp chip to bring everyone to that moment."
                : "A timestamp chip shows where the sender was in the video; the host can jump the room to it."}
            </p>
            {reportNotice && <p className="cinema-report-notice" role="status">{reportNotice}</p>}
            {report
              ? <form className="cinema-report" onSubmit={(event) => { event.preventDefault(); void sendReport(); }}>
                <strong>{report.label}</strong>
                <p>A moderator reads this. The room keeps going while they look.</p>
                <textarea
                  value={reportReason}
                  maxLength={500}
                  rows={3}
                  placeholder="What happened? (optional)"
                  aria-label="What happened?"
                  onChange={(event) => setReportReason(event.target.value)}
                />
                <div className="cinema-controls">
                  <button type="submit" disabled={reportBusy}>{reportBusy ? "Sending…" : "Send report"}</button>
                  <button type="button" className="secondary" disabled={reportBusy} onClick={() => setReport(null)}>Cancel</button>
                </div>
              </form>
              : account && <div className="cinema-controls cinema-sub">
                <button type="button" className="secondary" onClick={() => { setReport({ label: "Report this room" }); setReportReason(""); setReportNotice(""); }}>
                  <Flag size={13} aria-hidden /> Report this room
                </button>
                {sourceType === "UPLOAD" && videoId && <button type="button" className="secondary" onClick={() => { setReport({ video: true, label: "Report the video" }); setReportReason(""); setReportNotice(""); }}>
                  <Flag size={13} aria-hidden /> Report the video
                </button>}
              </div>}
          </>}
      </section>
      </Sheet>
    </aside>

    <nav className="cinema-dock" aria-label="Room bar">
      <button
        type="button"
        className="cinema-dock-people"
        aria-expanded={sheet === "people"}
        aria-controls="cinema-sheet-people"
        onClick={() => openSheet("people")}
      >
        <span className="cinema-dock-avatars" aria-hidden>
          {people.slice(0, 4).map((member) => <span key={member.studentId} className="cinema-dock-avatar">{memberInitial(member.displayName)}</span>)}
        </span>
        <span className="cinema-dock-count">{people.length} {people.length === 1 ? "person" : "people"} here</span>
      </button>
      {room.isHost && active && <div className="cinema-dock-actions">
        {room.status === "CREATED" && !pendingStart && <button type="button" disabled={Boolean(busy)} aria-label="Open the room" data-tip="Open the room" onClick={() => void act("OPEN")}><Play size={17} aria-hidden /></button>}
        {!room.isPrivate && (room.joinLocked
          ? <button type="button" disabled={Boolean(busy)} aria-label="Let people in again" data-tip="Let people in again" onClick={() => void act("UNLOCK")}><LockOpen size={17} aria-hidden /></button>
          : <button type="button" disabled={Boolean(busy)} aria-label="Lock the door" data-tip="Lock the door" onClick={() => void act("LOCK")}><Lock size={17} aria-hidden /></button>)}
        <button type="button" className={muteSent ? "is-active" : ""} aria-label="Mute everyone" data-tip="Mute everyone" onClick={askMuteAll}><MicOff size={17} aria-hidden /></button>
        <button type="button" aria-label="AI whiteboard" data-tip="AI whiteboard" aria-expanded={sheet === "board"} aria-controls="cinema-sheet-board" onClick={showBoard}><Sparkles size={17} aria-hidden /></button>
        <button type="button" className="danger" disabled={Boolean(busy)} aria-label="End the room" data-tip="End the room" onClick={() => void act("END")}><Square size={17} aria-hidden /></button>
      </div>}
    </nav>

    <div className="cinema-toasts" aria-live="polite">
      {toasts.map((toast) => <article key={toast.id} className="cinema-toast">
        <header>
          <span className="cinema-toast-tag"><Sparkles size={11} aria-hidden /> Session board</span>
          <button type="button" aria-label="Dismiss this summary" onClick={() => dismissToast(toast.id)}><X size={13} aria-hidden /></button>
        </header>
        <strong>{toast.title}</strong>
        <p>{toast.body}</p>
        <button type="button" className="cinema-toast-open" onClick={() => { showBoard(); dismissToast(toast.id); }}>Open the board</button>
      </article>)}
    </div>
  </div>;
}

/**
 * One mobile panel. On a desktop the wrapper is an ordinary div and the panel
 * inside it sits in the room's grid exactly as it always did; under 900px the
 * stylesheet turns it into a fixed bottom sheet, hidden until `open`. The close
 * control is mobile-only, so the desktop never grows a second way to dismiss a
 * panel that was never modal.
 */
function Sheet(input: { open: boolean; id: string; label: string; onClose: () => void; children: ReactNode }) {
  return <div id={input.id} className={`cinema-sheet${input.open ? " is-open" : ""}`}>
    <button type="button" className="cinema-sheet-close" aria-label={`Close ${input.label}`} onClick={input.onClose}>
      <X size={16} aria-hidden />
    </button>
    {input.children}
  </div>;
}

/** 320 seconds reads as 05:20; an hour-long session keeps its hours. */
function clockTime(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${pad(minutes)}:${pad(remainder)}`;
}

/** A schedule instant on the reader's own clock, e.g. "19:05"; '' when absent. */
function clockCopy(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The presence list: live when the room has spoken, the page's list until then. */
function peopleOf(room: Room, live: { state: string; members: Array<{ studentId: string; displayName: string; isHost: boolean }> }) {
  if (live.members.length) {
    return live.members.map((member) => ({
      studentId: member.studentId,
      displayName: member.displayName,
      isHost: member.isHost,
    }));
  }
  return room.participants.map((member) => ({
    studentId: member.studentId,
    displayName: member.displayName,
    isHost: member.studentId === room.hostStudentId,
  }));
}

/** One letter for a dock avatar, or a dot when the room has no name to show. */
function memberInitial(name: unknown) {
  return String(name || "").trim().charAt(0).toUpperCase() || "•";
}

/**
 * One control-bar button: the icon in a circle, its name underneath, which is
 * how Zoom's bar reads at a glance. `active` marks a panel that is open or a
 * switch that is on; `danger` is the one button that ends the room.
 */
function ToolButton(input: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const className = input.danger ? "danger" : input.active ? "is-active" : undefined;
  return <button
    type="button"
    className={className}
    aria-label={input.label}
    data-tip={input.label}
    aria-pressed={input.active}
    disabled={input.disabled}
    onClick={input.onClick}
  >
    <span className="cinema-tool-icon">{input.children}</span>
    <span className="cinema-tool-label">{input.label}</span>
  </button>;
}

function connectionCopy(state: string) {
  if (state === "live") return "Live";
  if (state === "offline") return "Reconnecting…";
  if (state === "closed") return "Offline";
  return "Connecting…";
}
