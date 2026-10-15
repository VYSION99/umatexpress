"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Bookmark, Chats, ClosedCaption, Envelope, Flag, Hand, Lock, MicrophoneSlash, Notebook, PaperPlaneTilt, Play, Poll, Radio, Smile, Sparkle, Square, Timer, UserPlus, X } from "@/components/ui/MaterialIcon";
import { useStudentAccount } from "@/components/account/useStudentAccount";
import type { CinemaBookmark, CinemaRoom as Room } from "@/lib/cinema-engine/rooms";
import { CINEMA_CALL_MEMBER_LIMIT, CINEMA_REACTIONS, type CinemaReaction } from "@/lib/cinema-engine/protocol";
import { expectedPosition } from "@/lib/cinema-engine/sync";
import { useCinemaSocket } from "./useCinemaSocket";
import { CinemaCallButtons } from "./CinemaCallButtons";
import { CinemaInvites } from "./CinemaInvites";
import { CinemaMediaStrip } from "./CinemaMediaStrip";
import { MediaStreamVideo } from "./CinemaMediaVideo";
import { CinemaNotes } from "./CinemaNotes";
import { CinemaRecorderPanel } from "./CinemaRecorderPanel";
import { CinemaWhiteboardPanel } from "./CinemaWhiteboardPanel";
import { UploadPlayer } from "./UploadPlayer";
import { YouTubePlayer } from "./YouTubePlayer";
import { useCinemaMedia } from "./useCinemaMedia";
import { useCinemaRecorder } from "./useCinemaRecorder";
import { CinemaDialog } from "./CinemaDialog";
import { CinemaPollsPanel } from "./CinemaPollsPanel";
import { CinemaQuestionsPanel } from "./CinemaQuestionsPanel";
import { CinemaDiscussionAudience } from "./CinemaDiscussionAudience";
import { CinemaStageRequestsPanel } from "./CinemaStageRequestsPanel";
import { CinemaStudyPanel } from "./CinemaStudyPanel";
import { CinemaTranscriptPanel } from "./CinemaTranscriptPanel";
import type { CinemaTranscriptPrivacy, CinemaTranscriptSegment } from "@/lib/cinema-engine/transcripts";
import { SheetHandle } from "@/components/ui/SheetHandle";
import "./cinema.css";

/** Playback and devices belong to the room; changing tools never restarts a call. */
type CinemaSheet = "" | "board" | "notes" | "bookmarks" | "record" | "invite" | "chat" | "people" | "captions" | "polls" | "questions" | "study" | "more";

/** A room notice that is worth interrupting a video for: an automatic board. */
type CinemaToast = { id: string; title: string; body: string };

/** How long a toast stays before it folds itself away, in milliseconds. */
const TOAST_MS = 15_000;
/** At most this many toasts stack; the newest pushes the oldest out. */
const TOAST_KEEP = 3;

export function CinemaRoom({ initialRoom }: { initialRoom: Room }) {
  const [stageRole, setStageRole] = useState(initialRoom.currentRole);
  const onStageRole = useCallback((role: string) => setStageRole(role as Room["currentRole"]), []);
  const stage = ["HOST", "COHOST", "PRESENTER"].includes(stageRole);
  useEffect(() => {
    if (!initialRoom.discussionMode || !stage) return;
    const refresh = async () => {
      const response = await fetch(`/api/cinema/sessions/${initialRoom.id}/stage`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const data = await response.json() as { state?: { role?: string } };
      if (data.state?.role) setStageRole(data.state.role as Room["currentRole"]);
    };
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [initialRoom.discussionMode, initialRoom.id, stage]);
  if (initialRoom.discussionMode && !stage) return <CinemaDiscussionAudience initialRoom={initialRoom} onStageRole={onStageRole} />;
  return <CinemaStageRoom key={stageRole} initialRoom={{ ...initialRoom, currentRole: stageRole }} />;
}

function CinemaStageRoom({ initialRoom }: { initialRoom: Room }) {
  const { ready, account } = useStudentAccount();
  const needsEmailVerification = Boolean(ready && account && !account.emailVerified);
  const [room, setRoom] = useState<Room>(initialRoom);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<{ messageId?: string; video?: boolean; label: string } | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportNotice, setReportNotice] = useState("");
  const mobile = useSyncExternalStore(subscribeViewport, mobileViewport, () => false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const chatRequest = useRef<{ text: string; id: string } | null>(null);
  const [sheet, setSheet] = useState<CinemaSheet>("");
  const [reactionOpen, setReactionOpen] = useState(false);
  const [waitingMembers, setWaitingMembers] = useState<Array<{ studentId: string; displayName: string; requestedAt: string }>>([]);
  const [bookmarks, setBookmarks] = useState<CinemaBookmark[]>([]);
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [transcriptPrivacy, setTranscriptPrivacy] = useState<CinemaTranscriptPrivacy | null>(null);
  const [captionSegments, setCaptionSegments] = useState<CinemaTranscriptSegment[]>([]);
  const [captionNow, setCaptionNow] = useState(0);
  const [boardPrompt, setBoardPrompt] = useState("");
  /** Set for a moment after a mute-all goes out, so the host sees the ask land. */
  const [muteSent, setMuteSent] = useState(false);
  /** Automatic-board notices; the room's summaries arrive here, not in a panel. */
  const [toasts, setToasts] = useState<CinemaToast[]>([]);
  const joined = useRef(false);
  const chatEndRef = useRef<HTMLLIElement | null>(null);
  const muteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const enteredStatus = useRef(initialRoom.status);
  const roomActive = room.status === "CREATED" || room.status === "LIVE";
  // The socket is the room's live voice: it opens once the page knows who the
  // student is, and closes the moment the room stops being open.
  const live = useCinemaSocket({ roomId: room.id, enabled: Boolean(ready && account && roomActive && room.isMember) });
  // A live presence heartbeat keeps the durable participant record aligned
  // with actual time in the room. Certificates use this record, not RSVP.
  useEffect(() => {
    if (!account || !room.isMember || room.status !== "LIVE" || live.state !== "live") return;
    const timer = setInterval(() => {
      void fetch(`/api/cinema/sessions/${room.id}/join`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(timer);
  }, [account, room.id, room.isMember, room.status, live.state]);
  const active = roomActive && !live.closedReason;
  const effectiveRole = live.members.find(member => member.studentId === account?.id)?.role || room.currentRole;
  const canPresent = ["HOST", "COHOST", "PRESENTER"].includes(effectiveRole);
  const canManage = ["HOST", "COHOST"].includes(effectiveRole);
  const selected = sheet || (mobile ? "" : "chat");
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
  const memberAccount = account && room.isMember ? account : null;
  const roomMember = memberAccount && active && live.members.some(member => member.studentId === memberAccount.id) ? memberAccount : null;
  const handRaised = Boolean(account && live.members.find(member => member.studentId === account.id)?.handRaised);
  const callMembers = (room.discussionMode ? live.members.filter(member => ["HOST", "COHOST", "PRESENTER"].includes(member.role)) : live.members)
    .slice(0, room.discussionMode ? room.stageLimit : CINEMA_CALL_MEMBER_LIMIT);
  const callEligible = Boolean(account && callMembers.some(member => member.studentId === account.id));
  const media = useCinemaMedia({
    roomId: room.id,
    enabled: Boolean(roomMember && live.state === "live" && callEligible),
    selfId: roomMember?.id ?? "",
    members: callMembers,
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
  const stopScreen = media.stopScreen;
  const subscribeBoards = live.subscribeBoards;

  // An ended room releases the microphone and camera: the panel that used to
  // unmount and clean up is no longer the owner of the call.
  useEffect(() => {
    if (!active) releaseDevices();
  }, [active, releaseDevices]);

  useEffect(() => {
    if (!media.screenOn || !/presenter|already sharing/i.test(live.socketError)) return;
    stopScreen();
  }, [live.socketError, media.screenOn, stopScreen]);

  /** The host asks the room to mute; each member's browser does the muting. */
  const askMuteAll = () => {
    if (!canManage || !active) return;
    live.send({ type: "mute_all" });
    setMuteSent(true);
    if (muteTimer.current) clearTimeout(muteTimer.current);
    muteTimer.current = setTimeout(() => setMuteSent(false), 3200);
  };

  const showBoard = () => openSheet("board");

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

  useEffect(() => {
    if (room.waitingState !== "WAITING" || room.isMember) return;
    const poll = async () => {
      const response = await fetch(`/api/cinema/sessions/${room.id}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const data = await response.json() as { room?: Room };
      if (data.room?.waitingRoomEnabled === false && !data.room.isMember) {
        const joinResponse = await fetch(`/api/cinema/sessions/${room.id}/join`, { method: "POST", credentials: "same-origin" }).catch(() => null);
        if (joinResponse?.ok) {
          const joinedData = await joinResponse.json() as { room?: Room };
          if (joinedData.room) { setRoom(joinedData.room); return; }
        }
      }
      if (data.room) setRoom(data.room);
    };
    const timer = setInterval(() => void poll(), 4_000);
    return () => clearInterval(timer);
  }, [room.id, room.isMember, room.waitingState]);

  const loadWaiting = useCallback(async () => {
    if (!canManage) return;
    const response = await fetch(`/api/cinema/sessions/${room.id}/waiting`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { waiting?: Array<{ studentId: string; displayName: string; requestedAt: string }> };
    setWaitingMembers(data.waiting || []);
  }, [canManage, room.id]);

  useEffect(() => {
    if (selected !== "people" || !canManage || !room.waitingRoomEnabled) return;
    queueMicrotask(() => void loadWaiting());
    const timer = setInterval(() => void loadWaiting(), 5_000);
    return () => clearInterval(timer);
  }, [selected, canManage, room.waitingRoomEnabled, loadWaiting]);

  const decideWaiting = async (studentId: string, action: "ADMIT" | "REJECT") => {
    const response = await fetch(`/api/cinema/sessions/${room.id}/waiting`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId, action }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setError(data.error || "That admission decision could not be saved."); return; }
    await Promise.all([loadWaiting(), load()]);
  };

  const requestAdmissionAgain = async () => {
    const response = await fetch(`/api/cinema/sessions/${room.id}/join`, { method: "POST", credentials: "same-origin" });
    const data = await response.json() as { room?: Room; error?: string };
    if (!response.ok) { setError(data.error || "The room could not be joined."); return; }
    if (data.room) setRoom(data.room);
  };

  const setMemberRole = async (studentId: string, role: string) => {
    const response = await fetch(`/api/cinema/sessions/${room.id}/guests`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId, role }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setError(data.error || "That role could not be changed."); return; }
    await load();
  };

  // A chat that does not follow its own tail is a chat nobody reads.
  useEffect(() => {
    if (selected === "chat") chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [live.messages.length, selected]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/cinema/sessions/${initialRoom.id}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
    const data = await response.json() as { room?: Room };
      if (data.room) setRoom(data.room);
    } catch { /* a failed refresh leaves the last known room on screen */ }
  }, [initialRoom.id]);

  const loadBookmarks = useCallback(async () => {
    if (!room.isMember) return;
    const response = await fetch(`/api/cinema/sessions/${room.id}/bookmarks`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json() as { bookmarks?: CinemaBookmark[] };
    setBookmarks(data.bookmarks || []);
  }, [room.id, room.isMember]);

  useEffect(() => {
    if (selected !== "bookmarks") return;
    queueMicrotask(() => void loadBookmarks());
    const timer = setInterval(() => void loadBookmarks(), 8_000);
    return () => clearInterval(timer);
  }, [selected, loadBookmarks]);

  const addBookmark = async () => {
    if (!live.playback || !bookmarkLabel.trim()) return;
    setBookmarkBusy(true);
    setError("");
    try {
      const atSeconds = Math.round(expectedPosition(live.playback, live.clock.now()));
      const response = await fetch(`/api/cinema/sessions/${room.id}/bookmarks`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: bookmarkLabel, atSeconds }),
      });
      const data = await response.json() as { bookmark?: CinemaBookmark; error?: string };
      if (!response.ok) throw new Error(data.error || "The bookmark could not be saved.");
      setBookmarkLabel("");
      await loadBookmarks();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The bookmark could not be saved.");
    } finally {
      setBookmarkBusy(false);
    }
  };

  const removeBookmark = async (bookmarkId: string) => {
    const response = await fetch(`/api/cinema/sessions/${room.id}/bookmarks?bookmarkId=${encodeURIComponent(bookmarkId)}`, { method: "DELETE", credentials: "same-origin" });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setError(data.error || "That bookmark could not be removed."); return; }
    setBookmarks((current) => current.filter((bookmark) => bookmark.id !== bookmarkId));
  };

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
      const now = live.clock.now();
      setClockNow(now);
      if (!reloaded && startsAtMs <= now) { reloaded = true; void load(); }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [waiting, startsAtMs, load, live.clock]);
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

  const people = active ? peopleOf(room, live) : [];
  const canSeek = canPresent && live.state === "live" && Boolean(live.playback);

  /** The playhead a message is asking about, or null before the video starts. */
  const chatTimestamp = () => {
    if (!live.playback) return null;
    const at = Math.round(expectedPosition(live.playback, live.clock.now()));
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

  const playheadSeconds = useCallback(() => live.playback ? Math.max(0, Math.round(expectedPosition(live.playback, live.clock.now()))) : 0, [live.playback, live.clock]);

  // Caption visibility is independent of the transcript sheet: once the host
  // enables it, every room member receives the newest line over the player.
  useEffect(() => {
    if (!room.isMember || !account) return;
    let disposed = false;
    const refresh = async () => {
      const at = live.playback ? Math.max(0, Math.round(expectedPosition(live.playback, live.clock.now()))) : 0;
      const response = await fetch(`/api/cinema/sessions/${room.id}/transcript?captions=1&at=${at}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
      if (!response?.ok || disposed) return;
      const data = await response.json() as { privacy?: CinemaTranscriptPrivacy; segments?: CinemaTranscriptSegment[] };
      if (data.privacy) setTranscriptPrivacy(data.privacy);
      if (data.privacy?.transcriptEnabled) setCaptionSegments(data.segments || []);
      if (data.privacy?.transcriptEnabled === false) setCaptionSegments([]);
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [room.id, room.isMember, account, live.playback, live.clock]);

  useEffect(() => {
    if (!transcriptPrivacy?.transcriptEnabled) return;
    const timer = setInterval(() => setCaptionNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [transcriptPrivacy?.transcriptEnabled]);

  const currentCaption = (() => {
    if (!transcriptPrivacy?.transcriptEnabled) return null;
    const recentCall = captionSegments.filter((segment) => segment.source === "CALL" && captionNow - Date.parse(segment.createdAt) < 8_000).at(-1);
    if (recentCall) return recentCall;
    const at = playheadSeconds();
    const uploads = captionSegments.filter((segment) => segment.source === "UPLOAD");
    const index = uploads.findLastIndex((segment) => segment.atSeconds <= at);
    if (index < 0) return null;
    const current = uploads[index];
    const next = uploads[index + 1];
    return (!next && at - current.atSeconds < 15) || (next && at < next.atSeconds) ? current : null;
  })();
  const screenMember = live.members.find((member) => member.screen);
  const screenStream = screenMember
    ? screenMember.studentId === account?.id ? media.localStream : media.remote.find((peer) => peer.studentId === screenMember.studentId)?.stream || null
    : null;

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
    <CinemaDialog open={confirmEnd} title="End this room?" onClose={() => setConfirmEnd(false)} busy={Boolean(busy)}>
      <p>Playback and calls will stop for everyone. Any unsaved recording can still be downloaded from this page.</p>
      <div className="cinema-controls"><button type="button" className="danger" disabled={Boolean(busy)} onClick={() => { void act("END").then(() => setConfirmEnd(false)); }}>End room for everyone</button><button type="button" className="secondary" onClick={() => setConfirmEnd(false)}>Keep watching</button></div>
    </CinemaDialog>
    <div className="cinema-stage">
      <section className="cinema-video">
        <div className="cinema-video-head">
          <div className="cinema-video-title">
            <strong>{room.title}</strong>
            {room.isPrivate && <span className="cinema-chip is-private"><Lock size={11} aria-hidden /> Private</span>}
            {room.waitingRoomEnabled && <span className="cinema-chip is-scheduled"><UserPlus size={11} aria-hidden /> Waiting room</span>}
            {room.isPrivate && !room.isHost && <span className="cinema-chip is-private"><Envelope size={11} aria-hidden /> Invited guest</span>}
            {pendingStart && startsInSeconds > 0 && <span className="cinema-chip is-scheduled"><Timer size={11} aria-hidden /> Starts in {clockTime(startsInSeconds)}</span>}
            {room.status === "LIVE" && endsAtMs > 0 && <span className="cinema-chip is-scheduled"><Timer size={11} aria-hidden /> Runs until {clockCopy(room.endsAt)}</span>}
          </div>
          <span className="cinema-video-hint">
            {active
              ? pendingStart
                ? "Your room will start automatically at the scheduled time."
                : room.discussionMode ? "Speaking stage · the audience watches the separate live broadcast." : "Watching together. The host, co-hosts, and presenters can control playback."
              : "This room has ended."}
          </span>
        </div>
        {room.discussionMode && active
          ? <div className="cinema-discussion-stage-note"><span className="cinema-eyebrow">SPEAKING STAGE</span><h2>Discuss without broadcast echo</h2><p>This call connects the host and invited speakers. The audience watches the live feed you attached to the event. Keep your broadcast setup running so they can hear the discussion.</p><a href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`} target="_blank" rel="noopener noreferrer">Open broadcast monitor</a></div>
          : active && live.state === "live" && sourceType === "YOUTUBE" && videoId
          ? <YouTubePlayer
            videoId={videoId}
            isHost={canPresent}
            playback={live.playback}
            now={live.clock.now}
            onAction={live.send}
          />
          : active && live.state === "live" && sourceType === "UPLOAD" && videoId
            ? <UploadPlayer
              roomId={room.id}
              isHost={canPresent}
              playback={live.playback}
              now={live.clock.now}
              onAction={live.send}
            />
            : <p className="cinema-video-closed">
              {active
                ? !account ? "Sign in to join this room." : room.waitingState === "WAITING" ? "You are in the waiting room. The host or a co-host will admit you." : room.waitingState === "REJECTED" ? "The host could not admit this request." : !room.isMember ? "Joining the room…" : live.state !== "live" ? "Connecting to the room…" : room.isHost
                  ? "No video is attached yet. Add one from the Cinema lobby — the room picks it up as soon as it is ready."
                  : "No video is attached yet. The host adds it from the Cinema lobby."
                : roomActive ? live.closedReason || "The room connection has closed." : "This room has ended."}
            </p>}
        {roomActive && needsEmailVerification && <Link className="cinema-verify-link" href={`/account?next=${encodeURIComponent(`/cinema/${room.id}`)}`}><Envelope size={18} aria-hidden /> Verify your email</Link>}
        {currentCaption && <div className="cinema-live-caption" aria-live="polite"><strong>{currentCaption.source === "CALL" ? currentCaption.speakerName : "Captions"}</strong> {currentCaption.text}</div>}
        {!active && <Link className="cinema-cta" href="/cinema/rooms">Back to your rooms</Link>}
        {active && account && room.waitingState === "REJECTED" && <button type="button" className="cinema-cta" onClick={() => void requestAdmissionAgain()}>Request admission again</button>}
        {active && !account && <Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/${room.id}`)}`}>Sign in to join</Link>}
      </section>

      {screenMember && screenStream && <section className="cinema-presentation" aria-label={`${screenMember.displayName || "Presenter"}'s shared screen`}>
        <header><strong>{screenMember.studentId === account?.id ? "You are presenting" : `${screenMember.displayName || "Presenter"} is presenting`}</strong><span>Live screen</span></header>
        <MediaStreamVideo stream={screenStream} muted={screenMember.studentId === account?.id} className="cinema-presentation-stream" pictureInPicture />
      </section>}

      {roomMember && <CinemaMediaStrip
        media={media}
        members={live.members}
        selfId={roomMember.id}
      />}
      <div className="cinema-toolbar" role="toolbar" aria-label="Room controls">
        {roomMember && callEligible && <div className="cinema-toolbar-group">
          <CinemaCallButtons
            media={media}
            recorder={recorder}
            recordOpen={sheet === "record"}
            hideRecorder={mobile}
            onToggleRecord={() => openSheet("record")}
            canShare={canPresent}
            labels
          />
        </div>}
        <div className="cinema-toolbar-group cinema-tools">
          {roomMember && <ToolButton label={handRaised ? "Lower hand" : "Raise hand"} active={handRaised} onClick={() => { live.send({ type: "hand_state", raised: !handRaised }); }}><Hand size={18} aria-hidden /></ToolButton>}
          {roomMember && <ToolButton label="React" active={reactionOpen} onClick={() => setReactionOpen(current => !current)}><Smile size={18} aria-hidden /></ToolButton>}
          <ToolButton label="Chat" active={selected === "chat"} onClick={() => openSheet("chat")}><Chats size={18} aria-hidden /></ToolButton>
          {room.discussionMode && <ToolButton label="Questions" active={selected === "questions"} onClick={() => openSheet("questions")}><Hand size={18} aria-hidden /></ToolButton>}
          <ToolButton label="People" active={selected === "people"} onClick={() => openSheet("people")}><UserPlus size={18} aria-hidden /></ToolButton>
          <ToolButton label="Notes" active={selected === "notes"} onClick={() => openSheet("notes")}><Notebook size={18} aria-hidden /></ToolButton>
          {memberAccount && <ToolButton label="Bookmarks" active={selected === "bookmarks"} onClick={() => openSheet("bookmarks")}><Bookmark size={18} aria-hidden /></ToolButton>}
          {account && <ToolButton label="Whiteboard" active={selected === "board"} onClick={showBoard}><Sparkle size={18} aria-hidden /></ToolButton>}
          {memberAccount && <ToolButton label="Captions" active={selected === "captions"} onClick={() => openSheet("captions")}><ClosedCaption size={18} aria-hidden /></ToolButton>}
          {memberAccount && <ToolButton label="Polls" active={selected === "polls"} onClick={() => openSheet("polls")}><Poll size={18} aria-hidden /></ToolButton>}
          <ToolButton label="More" active={selected === "more"} onClick={() => openSheet("more")}><Envelope size={18} aria-hidden /></ToolButton>
        </div>
      </div>
      {reactionOpen && roomMember && <div className="cinema-reaction-picker" role="group" aria-label="Send a reaction">
        {CINEMA_REACTIONS.map((emoji) => <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => { live.send({ type: "reaction", emoji: emoji as CinemaReaction }); setReactionOpen(false); }}>{emoji}</button>)}
      </div>}
      {live.reactions.length > 0 && <div className="cinema-live-reactions" aria-live="polite">
        {live.reactions.map((reaction) => <span key={reaction.id} title={`${reaction.name} reacted`}>{reaction.emoji}<small>{reaction.name}</small></span>)}
      </div>}
      {/* The old Voice & video card is gone; what it had to say that the
          buttons cannot is one line here, where the call's pictures live. */}
      {roomMember && !callEligible && <p className="cinema-note">{room.discussionMode ? "You are in the audience. Raise your hand to request a speaking place; the host controls the stage." : `The call supports ${CINEMA_CALL_MEMBER_LIMIT} people. You can still watch and use chat, notes and the whiteboard.`}</p>}
      {roomMember && media.error && <p className="cinema-error">{media.error}</p>}
      {roomMember && !media.error && media.policyLoaded && !media.policy.voice && !media.policy.camera && <p className="cinema-note">
        Voice and camera are switched off on this deployment. Chat and the video still work.
      </p>}

      {error && !((needsEmailVerification || !roomActive) && error === "Verify your email before joining a Cinema event.") && <p className="cinema-error" role="alert">{error}</p>}
      {roomActive && live.socketError && <p className="cinema-error" role="status">{live.socketError}</p>}
      {recorder.recoveryUrl && selected !== "record" && <button className="cinema-recovery" onClick={() => openSheet("record")}>Your recording is ready to download — open Recorder</button>}
      {active && room.isMember && live.state !== "live" && <p role="status" className="cinema-note">Reconnecting. Playback is paused and devices are off.</p>}
    </div>

    <aside className="cinema-card cinema-side">
      <nav className="cinema-panel-tabs" aria-label="Room tools">
        {([['chat', 'Chat'], ...(room.discussionMode ? [['questions', 'Questions'] as const] : []), ['people', 'People'], ['notes', 'Notes'], ['board', 'Whiteboard']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={selected === id} aria-controls={`cinema-sheet-${id}`} onClick={() => setSheet(id)}>{label}</button>)}
        <button type="button" onClick={() => setSheet(selected === 'more' ? 'chat' : 'more')}>More</button>
      </nav>
      <Sheet open={selected === "more"} mobile={mobile} id="cinema-sheet-more" label="Room actions" onClose={closeSheet}>
        <div className="cinema-action-list">
          <button onClick={() => setSheet("people")}><UserPlus size={18} /> People in this room</button>
          <button onClick={() => setSheet("notes")}><Notebook size={18} /> My notes</button>
          <button onClick={() => setSheet("captions")}><ClosedCaption size={18} /> Captions and transcript</button>
          <button onClick={() => setSheet("polls")}><Poll size={18} /> Polls and quizzes</button>
          <button onClick={() => setSheet("study")}><Sparkle size={18} /> Study pack</button>
          <button onClick={() => setSheet("invite")}><UserPlus size={18} /> Invite students</button>
          <button onClick={() => setSheet("record")}><Radio size={18} /> My recordings</button>
          {canManage && active && <>
            {room.isHost && room.status === "CREATED" && !pendingStart && <button disabled={Boolean(busy)} onClick={() => void act("OPEN")}><Play size={18} /> Start now</button>}
            {room.isHost && !room.isPrivate && <button disabled={Boolean(busy)} onClick={() => void act(room.joinLocked ? "UNLOCK" : "LOCK")}><Lock size={18} /> {room.joinLocked ? "Unlock room" : "Lock room"}</button>}
            {room.isHost && <button disabled={Boolean(busy)} onClick={() => void act(room.waitingRoomEnabled ? "WAITING_OFF" : "WAITING_ON")}><UserPlus size={18} /> {room.waitingRoomEnabled ? "Turn off waiting room" : "Turn on waiting room"}</button>}
            <button onClick={askMuteAll}><MicrophoneSlash size={18} /> {muteSent ? "Mute request sent" : "Mute everyone"}</button>
            {room.isHost && <button className="danger" onClick={() => { setSheet(""); setConfirmEnd(true); }}><Square size={18} /> End room</button>}
          </>}
        </div>
      </Sheet>
      <Sheet open={selected === "record"} mobile={mobile} id="cinema-sheet-record" label="Recorder" onClose={closeSheet}>
        {selected === "record" && <CinemaRecorderPanel media={media} recorder={recorder} connected={live.state === "live"} />}
      </Sheet>

      <Sheet open={selected === "board"} mobile={mobile} id="cinema-sheet-board" label="AI whiteboard" onClose={closeSheet}>
        {account && (selected === "board" || live.boardPolicy === "AUTO") && <CinemaWhiteboardPanel
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
            now={live.clock.now}
          initialQuestion={boardPrompt}
          onInitialQuestionUsed={() => setBoardPrompt("")}
        />}
      </Sheet>

      <Sheet open={selected === "notes"} mobile={mobile} id="cinema-sheet-notes" label="My notes" onClose={closeSheet}>
        <CinemaNotes roomId={room.id} />
      </Sheet>

      <Sheet open={selected === "captions"} mobile={mobile} id="cinema-sheet-captions" label="Captions and transcript" onClose={closeSheet}>
        {memberAccount && <CinemaTranscriptPanel roomId={room.id} isHost={room.isHost} active={active} atSeconds={playheadSeconds} onSeek={seekTo} canSeek={canSeek} onPrivacy={setTranscriptPrivacy} />}
      </Sheet>

      <Sheet open={selected === "polls"} mobile={mobile} id="cinema-sheet-polls" label="Polls and quizzes" onClose={closeSheet}>
        {memberAccount && <CinemaPollsPanel roomId={room.id} canManage={canManage} />}
      </Sheet>
      <Sheet open={selected === "questions"} mobile={mobile} id="cinema-sheet-questions" label="Audience questions" onClose={closeSheet}>
        {room.discussionMode && selected === "questions" && roomMember && <CinemaQuestionsPanel roomId={room.id} canManage={canManage} />}
      </Sheet>

      <Sheet open={selected === "study"} mobile={mobile} id="cinema-sheet-study" label="Study intelligence" onClose={closeSheet}>
        {memberAccount && <CinemaStudyPanel roomId={room.id} aiEnabled={transcriptPrivacy?.aiStudyEnabled === true} roomEnded={room.status === "ENDED"} canGenerate={canManage} onSeek={seekTo} canSeek={canSeek} />}
      </Sheet>

      <Sheet open={selected === "bookmarks"} mobile={mobile} id="cinema-sheet-bookmarks" label="Shared bookmarks" onClose={closeSheet}>
        <section className="cinema-bookmarks">
          <p className="cinema-note">Mark useful moments for everyone in this room. Bookmark labels and timestamps are shared with room members.</p>
          <form onSubmit={(event) => { event.preventDefault(); void addBookmark(); }}>
            <label htmlFor="cinema-bookmark-label">Moment label</label>
            <div><input id="cinema-bookmark-label" maxLength={100} value={bookmarkLabel} onChange={(event) => setBookmarkLabel(event.target.value)} placeholder="e.g. Key proof of theorem" />
              <button type="submit" disabled={bookmarkBusy || !bookmarkLabel.trim() || !live.playback}>{bookmarkBusy ? "Saving…" : "Mark this moment"}</button></div>
            {live.playback && <small>Current position: {clockTime(Math.round(expectedPosition(live.playback, live.clock.now())))}.</small>}
            {live.playback && <button type="button" className="secondary" onClick={() => { setBoardPrompt(`Explain the concept at ${clockTime(playheadSeconds())} in simple steps, then give one short example.`); setSheet("board"); }}>Explain this moment</button>}
          </form>
          {bookmarks.length ? <ol>{bookmarks.map((bookmark) => {
            const canRemove = bookmark.studentId === account?.id || canManage;
            return <li key={bookmark.id}>
              <button type="button" className="cinema-bookmark-jump" disabled={!canSeek} onClick={() => seekTo(bookmark.atSeconds)}>
                <strong>{clockTime(bookmark.atSeconds)}</strong><span>{bookmark.label}</span><small>Added by {bookmark.displayName}</small>
              </button>
              {canRemove && <button type="button" className="cinema-bookmark-remove" aria-label={`Remove ${bookmark.label}`} onClick={() => void removeBookmark(bookmark.id)}><X size={16} aria-hidden /></button>}
            </li>;
          })}</ol> : <p className="cinema-note">No shared moments yet. Add the first one while the video is playing.</p>}
        </section>
      </Sheet>

      <Sheet open={selected === "invite"} mobile={mobile} id="cinema-sheet-invite" label="Invite" onClose={closeSheet}>
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


      <Sheet open={selected === "people"} mobile={mobile} id="cinema-sheet-people" label="Who's here" onClose={closeSheet}>
      <section className="cinema-side-people">
      <div className="cinema-presence-head">
        <h2>Who&apos;s here</h2>
        {account && <span className={`cinema-link is-${live.state}`}>{connectionCopy(live.state)}</span>}
      </div>
      {!ready
        ? <p className="cinema-note">Checking your account…</p>
        : !account
          ? <>
            <p className="cinema-note">Sign in with your verified account to join and appear here.</p>
            <div className="cinema-controls cinema-sub">
              <Link className="cinema-cta" href={`/account?next=${encodeURIComponent(`/cinema/${room.id}`)}`}>Sign in to join</Link>
            </div>
          </>
          : <>
            {room.discussionMode && canManage && selected === "people" && <CinemaStageRequestsPanel roomId={room.id} stageLimit={room.stageLimit} />}
            <ul className="cinema-people">
              {people.map((member) => <li key={member.studentId}>
                <span className="cinema-person-name">{member.handRaised && <Hand size={16} aria-label="Hand raised" />}{member.displayName || "Member"}</span>
                {(room.isHost || (room.discussionMode && effectiveRole === "COHOST" && member.role !== "COHOST")) && !member.isHost ? <select aria-label={`Role for ${member.displayName || "member"}`} value={member.role} onChange={(event) => void setMemberRole(member.studentId, event.target.value)}>
                  <option value="VIEWER">Viewer</option><option value="PRESENTER">Presenter</option>{room.isHost && <option value="COHOST">Co-host</option>}
                </select> : <span>{member.role === "COHOST" ? "Co-host" : member.role === "PRESENTER" ? "Presenter" : member.isHost ? "Host" : "Viewer"}</span>}
              </li>)}
            </ul>
            {canManage && room.waitingRoomEnabled && <div className="cinema-waiting-list">
              <h3>Waiting room <span>{waitingMembers.length}</span></h3>
              {waitingMembers.length === 0 ? <p className="cinema-note">Nobody is waiting.</p> : waitingMembers.map((member) => <div key={member.studentId}>
                <strong>{member.displayName}</strong><span><button onClick={() => void decideWaiting(member.studentId, "ADMIT")}>Admit</button><button className="secondary" onClick={() => void decideWaiting(member.studentId, "REJECT")}>Decline</button></span>
              </div>)}
            </div>}
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

      <Sheet open={selected === "chat"} mobile={mobile} id="cinema-sheet-chat" label="Room chat" onClose={closeSheet}>
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
                if (chatBusy) return;
                const text = draft;
                if (chatRequest.current?.text !== text) chatRequest.current = { text, id: crypto.randomUUID() };
                setChatBusy(true); setChatError("");
                void live.sendChat(text, chatTimestamp(), chatRequest.current.id).then(() => {
                  setDraft(current => current === text ? "" : current);
                  chatRequest.current = null;
                }).catch(error => setChatError(error instanceof Error ? error.message : "Message failed. Please retry.")).finally(() => setChatBusy(false));
              }}
            >
              <input
                value={draft}
                maxLength={500}
                placeholder={live.state === "live" ? "Ask the room…" : "Chat returns with the connection"}
                aria-label="Message the room"
                disabled={chatBusy}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" aria-label="Send the message" disabled={chatBusy || !draft.trim() || live.state !== "live"}>
                <PaperPlaneTilt size={15} aria-hidden />
              </button>
            </form>
            {chatBusy && <p role="status">Sending…</p>}
            {chatError && <p className="cinema-error" role="alert">{chatError} Your text is kept above.</p>}
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

    <div className="cinema-toasts" aria-live="polite">
      {toasts.map((toast) => <article key={toast.id} className="cinema-toast">
        <header>
          <span className="cinema-toast-tag"><Sparkle size={11} aria-hidden /> Session board</span>
          <button type="button" aria-label="Dismiss this summary" onClick={() => dismissToast(toast.id)}><X size={13} aria-hidden /></button>
        </header>
        <strong>{toast.title}</strong>
        <p>{toast.body}</p>
        <button type="button" className="cinema-toast-open" onClick={() => { showBoard(); dismissToast(toast.id); }}>Open the board</button>
      </article>)}
    </div>
  </div>;
}

const viewportQuery = "(max-width: 900px)";
function mobileViewport() { return window.matchMedia(viewportQuery).matches; }
function subscribeViewport(callback: () => void) {
  const query = window.matchMedia(viewportQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function Sheet(input: { open: boolean; mobile: boolean; id: string; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!input.mobile || !input.open || !node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = "hidden";
    return () => { node.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [input.mobile, input.open]);
  if (!input.mobile) return <section id={input.id} hidden={!input.open} className="cinema-tab-panel" aria-label={input.label}>{input.children}</section>;
  return <dialog ref={ref} id={input.id} className="cinema-dialog cinema-tool-dialog" aria-label={input.label}
    onCancel={event => { event.preventDefault(); input.onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) input.onClose(); }}>
    <SheetHandle onDismiss={input.onClose} />
    <header><h2>{input.label}</h2><button type="button" aria-label={`Close ${input.label}`} onClick={input.onClose}><X size={20} aria-hidden /></button></header>
    <div className="cinema-dialog-body">{input.children}</div>
  </dialog>;
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
function peopleOf(room: Room, live: { state: string; members: Array<{ studentId: string; displayName: string; isHost: boolean; role: Room["participants"][number]["role"]; handRaised: boolean }> }) {
  if (live.members.length) {
    return live.members.map((member) => ({
      studentId: member.studentId,
      displayName: member.displayName,
      isHost: member.isHost,
      role: member.role,
      handRaised: member.handRaised,
    }));
  }
  return room.participants.map((member) => ({
    studentId: member.studentId,
    displayName: member.displayName,
    isHost: member.studentId === room.hostStudentId,
    role: member.role,
    handRaised: false,
  }));
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
