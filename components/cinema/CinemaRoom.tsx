"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Flag, Globe, Lock, LockOpen, Mail, MessagesSquare, Mic, MicOff, NotebookPen, Play, Radio, Send, Sparkles, Square, Upload, UserPlus, X,
} from "lucide-react";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaRoom as Room } from "@/lib/cinema-engine/rooms";
import { expectedPosition } from "@/lib/cinema-engine/sync";
import { useCinemaSocket } from "./useCinemaSocket";
import { CinemaInvites } from "./CinemaInvites";
import { CinemaMediaPanel } from "./CinemaMediaPanel";
import { CinemaNotes } from "./CinemaNotes";
import { CinemaSelfView } from "./CinemaSelfView";
import { CinemaWhiteboardPanel } from "./CinemaWhiteboardPanel";
import { UploadPanel } from "./UploadPanel";
import { UploadPlayer } from "./UploadPlayer";
import { YouTubePlayer } from "./YouTubePlayer";
import { useCinemaMedia } from "./useCinemaMedia";
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
 * On a phone the room is the video first: a floating rail at the top right
 * opens one panel at a time as a bottom sheet, and a Zoom-shaped dock holds
 * who is here and the host's actions at the bottom. The member's own camera
 * card floats beside the rail, and the call itself is owned here rather than
 * inside a panel, because a panel that unmounted would take the call with it.
 */
type CinemaSheet = "" | "upload" | "board" | "notes" | "media" | "invite" | "chat" | "people";

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
  const joined = useRef(false);
  const chatEndRef = useRef<HTMLLIElement | null>(null);
  const muteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // The call belongs to the room, not to the panel: the member's own camera
  // card renders beside the host controls, outside the Voice & video panel, and
  // a second copy of this hook would open a second call. The panel receives it.
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
  const releaseDevices = media.releaseDevices;

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

  // A pending notice is cleared on the way out; the room may unmount mid-count.
  useEffect(() => () => { if (muteTimer.current) clearTimeout(muteTimer.current); }, []);

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
      {room.isHost && active && <button
        type="button"
        className={muteSent ? "is-active" : ""}
        aria-label="Mute everyone"
        title="Mute everyone"
        onClick={askMuteAll}
      ><MicOff size={18} aria-hidden /></button>}
      {room.isHost && active && sourceType !== "UPLOAD" && <button
        type="button"
        className={sheet === "upload" ? "is-active" : ""}
        aria-label="Play a file"
        title="Play a file"
        aria-expanded={sheet === "upload"}
        aria-controls="cinema-sheet-upload"
        onClick={() => openSheet("upload")}
      ><Upload size={18} aria-hidden /></button>}
      {account && <button
        type="button"
        className={sheet === "board" ? "is-active" : ""}
        aria-label="AI whiteboard"
        title="AI whiteboard"
        aria-expanded={sheet === "board"}
        aria-controls="cinema-sheet-board"
        onClick={() => openSheet("board")}
      ><Sparkles size={18} aria-hidden /></button>}
      <button
        type="button"
        className={sheet === "notes" ? "is-active" : ""}
        aria-label="My notes"
        title="My notes"
        aria-expanded={sheet === "notes"}
        aria-controls="cinema-sheet-notes"
        onClick={() => openSheet("notes")}
      ><NotebookPen size={18} aria-hidden /></button>
      {active && account && live.members.length > 0 && <button
        type="button"
        className={sheet === "media" ? "is-active" : ""}
        aria-label="Mic and camera"
        title="Mic and camera"
        aria-expanded={sheet === "media"}
        aria-controls="cinema-sheet-media"
        onClick={() => openSheet("media")}
      ><Mic size={18} aria-hidden /></button>}
      <button
        type="button"
        className={sheet === "invite" ? "is-active" : ""}
        aria-label="Invite"
        title="Invite"
        aria-expanded={sheet === "invite"}
        aria-controls="cinema-sheet-invite"
        onClick={() => openSheet("invite")}
      ><UserPlus size={18} aria-hidden /></button>
      <button
        type="button"
        className={sheet === "chat" ? "is-active" : ""}
        aria-label="Room chat"
        title="Room chat"
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
          </div>
          <span className="cinema-video-hint">
            {active
              ? "The host's play, pause and seek land on every screen. Anyone in the room can watch; only the host drives."
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
                ? "No video is attached right now. The host can add one."
                : "This room has ended."}
            </p>}
      </section>

      <Sheet open={sheet === "media"} id="cinema-sheet-media" label="Mic and camera" onClose={closeSheet}>
        {roomMember && <CinemaMediaPanel
          roomId={room.id}
          selfId={roomMember.id}
          members={live.members}
          enabled={live.state === "live"}
          send={live.send}
          media={media}
        />}
      </Sheet>

      <Sheet open={sheet === "board"} id="cinema-sheet-board" label="AI whiteboard" onClose={closeSheet}>
        {account && <CinemaWhiteboardPanel
          roomId={room.id}
          selfId={account.id}
          isHost={room.isHost}
          active={active}
          connected={live.state === "live"}
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

      {roomMember && <CinemaSelfView media={media} />}

      {room.isHost && active && <section className="cinema-card cinema-host-card">
        <h2>Host controls</h2>
        <div className="cinema-controls">
          {room.status === "CREATED" && <button disabled={Boolean(busy)} onClick={() => void act("OPEN")}><Play size={15} /> Open the room</button>}
          {room.status === "LIVE" && <span className="cinema-chip is-live"><Radio size={12} /> Live</span>}
          {!room.isPrivate && (room.joinLocked
            ? <button className="secondary" disabled={Boolean(busy)} onClick={() => void act("UNLOCK")}><LockOpen size={15} /> Let people in again</button>
            : <button className="secondary" disabled={Boolean(busy)} onClick={() => void act("LOCK")}><Lock size={15} /> Lock the door</button>)}
          {room.isPrivate
            ? <button className="secondary" disabled={Boolean(busy)} onClick={() => void act("PUBLIC")}><Globe size={15} /> Make it public</button>
            : <button className="secondary" disabled={Boolean(busy)} onClick={() => void act("PRIVATE")}><Lock size={15} /> Make it private</button>}
          <button className="secondary" onClick={askMuteAll}><MicOff size={15} /> Mute everyone</button>
          <button className="danger" disabled={Boolean(busy)} onClick={() => void act("END")}><Square size={15} /> End the room</button>
          {muteSent && <span className="cinema-chip is-live" role="status"><MicOff size={11} aria-hidden /> Room asked to mute</span>}
        </div>
        <p className="cinema-note cinema-sub">
          {room.isPrivate
            ? "The room is private: only your guest list can read or join it. Manage the list from Invite; removing a guest takes back the invitation and the seat. An uploaded video makes the room private automatically."
            : room.joinLocked
              ? "The door is locked: only students already in can come back in."
              : "Anyone with the link and a UMaT account can join."}
        </p>
      </section>}

      <Sheet open={sheet === "upload"} id="cinema-sheet-upload" label="Play a file" onClose={closeSheet}>
        {room.isHost && active && sourceType !== "UPLOAD" && <UploadPanel roomId={room.id} onUploaded={() => void load()} />}
      </Sheet>

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
        {room.status === "CREATED" && <button type="button" disabled={Boolean(busy)} aria-label="Open the room" title="Open the room" onClick={() => void act("OPEN")}><Play size={17} aria-hidden /></button>}
        {!room.isPrivate && (room.joinLocked
          ? <button type="button" disabled={Boolean(busy)} aria-label="Let people in again" title="Let people in again" onClick={() => void act("UNLOCK")}><LockOpen size={17} aria-hidden /></button>
          : <button type="button" disabled={Boolean(busy)} aria-label="Lock the door" title="Lock the door" onClick={() => void act("LOCK")}><Lock size={17} aria-hidden /></button>)}
        {room.isPrivate
          ? <button type="button" disabled={Boolean(busy)} aria-label="Make it public" title="Make it public" onClick={() => void act("PUBLIC")}><Globe size={17} aria-hidden /></button>
          : <button type="button" disabled={Boolean(busy)} aria-label="Make it private" title="Make it private" onClick={() => void act("PRIVATE")}><Lock size={17} aria-hidden /></button>}
        <button type="button" className="danger" disabled={Boolean(busy)} aria-label="End the room" title="End the room" onClick={() => void act("END")}><Square size={17} aria-hidden /></button>
      </div>}
    </nav>
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

function connectionCopy(state: string) {
  if (state === "live") return "Live";
  if (state === "offline") return "Reconnecting…";
  if (state === "closed") return "Offline";
  return "Connecting…";
}
