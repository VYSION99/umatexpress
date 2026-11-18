"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, Eye, FilmSlate, Lock, LockOpen, MagnifyingGlass, Square, Trash, UserMinus, Users, X } from "@/components/ui/MaterialIcon";
import { CinemaDialog } from "@/components/cinema/CinemaDialog";
import type { ConsoleRoomDetail } from "@/lib/cinema-engine/rooms";

type ConsoleRoom = {
  id: string;
  title: string;
  hostStudentId: string;
  hostName: string;
  status: string;
  joinLocked: boolean;
  visibility: string;
  memberCount: number;
  startedAt: string;
  endedAt: string;
  createdAt: string;
  updatedAt: string;
};
type Summary = { listed: number; live: number; waiting: number; ended: number };

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const FILTERS = [
  { id: "ACTIVE", label: "Live & open" },
  { id: "ENDED", label: "Ended" },
  { id: "ALL", label: "All" },
] as const;
const statusBadge = (status: string) => status === "LIVE" ? "approved" : status === "CREATED" ? "pending" : "draft";

export function CinemaRoomsPanel() {
  const [rooms, setRooms] = useState<ConsoleRoom[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("ACTIVE");
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const sequenceRef = useRef(0);
  const [confirmed, setConfirmed] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  // Inspect modal state
  const [inspectRoomId, setInspectRoomId] = useState<string | null>(null);
  const [roomDetail, setRoomDetail] = useState<ConsoleRoomDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const load = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    setLoading(true); setError("");
    try {
      const search = searchQuery.trim() ? `&q=${encodeURIComponent(searchQuery.trim())}` : "";
      const response = await fetch(`/api/console/cinema/sessions?status=${filter}&offset=${offset}${search}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { rooms?: ConsoleRoom[]; hasMore?: boolean; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error || "The rooms could not be loaded.");
      if (sequence !== sequenceRef.current) return;
      setHasMore(data.hasMore === true);
      setRooms(data.rooms || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      if (sequence !== sequenceRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "The rooms could not be loaded.");
    } finally { if (sequence === sequenceRef.current) setLoading(false); }
  }, [filter, searchQuery, offset]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const loadDetail = useCallback(async (roomId: string) => {
    setLoadingDetail(true);
    try {
      const response = await fetch(`/api/console/cinema/sessions/${roomId}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { room?: ConsoleRoomDetail; error?: string };
      if (!response.ok || !data.room) throw new Error(data.error || "Could not read room details.");
      setRoomDetail(data.room);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read room details.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  function openInspect(roomId: string) {
    setInspectRoomId(roomId);
    setRoomDetail(null);
    void loadDetail(roomId);
  }

  async function endRoom(roomId: string, title: string) {
    setBusy(roomId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/console/cinema/sessions/${roomId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "END_ROOM" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The room could not be ended.");
      setNotice(`"${title}" has ended. Sockets were closed and new joins refused.`);
      await load();
      if (inspectRoomId === roomId) await loadDetail(roomId);
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : "The room could not be ended.");
    } finally {
      setBusy("");
      setConfirmed("");
    }
  }

  async function toggleLock(roomId: string, locked: boolean) {
    setBusy(roomId);
    try {
      const response = await fetch(`/api/console/cinema/sessions/${roomId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: locked ? "LOCK_ROOM" : "UNLOCK_ROOM" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not change join lock.");
      setNotice(locked ? "Room join locked." : "Room join unlocked.");
      await load();
      if (inspectRoomId === roomId) await loadDetail(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change join lock.");
    } finally {
      setBusy("");
    }
  }

  async function kickParticipant(roomId: string, studentId: string) {
    setBusy(studentId);
    try {
      const response = await fetch(`/api/console/cinema/sessions/${roomId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "KICK_PARTICIPANT", studentId, reason: "Moderator action" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not kick participant.");
      setNotice("Participant removed and disconnected.");
      if (inspectRoomId === roomId) await loadDetail(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not kick participant.");
    } finally {
      setBusy("");
    }
  }

  async function deleteMessage(roomId: string, messageId: string) {
    setBusy(messageId);
    try {
      const response = await fetch(`/api/console/cinema/sessions/${roomId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "REMOVE_MESSAGE", messageId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not remove message.");
      setNotice("Message removed from chat and replays.");
      if (inspectRoomId === roomId) await loadDetail(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove message.");
    } finally {
      setBusy("");
    }
  }

  return <section className="console-panel cinema-rooms-panel" aria-labelledby="cinema-rooms-heading">
    <div className="cinema-rooms-heading">
      <div>
        <span className="cinema-rooms-heading-icon"><FilmSlate size={20} aria-hidden /></span>
        <div><h2 id="cinema-rooms-heading">Room directory</h2><p>Monitor sessions, inspect participants, and moderate rooms.</p></div>
      </div>
      <button type="button" className="console-panel-close" onClick={() => void load()} disabled={loading}><ArrowsClockwise size={16} aria-hidden />Refresh</button>
    </div>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    {summary && <div className="cinema-room-summary" aria-label="Room totals">
      <span><strong>{summary.live}</strong> Live</span>
      <span><strong>{summary.waiting}</strong> Open</span>
      <span><strong>{summary.listed}</strong> Shown on this page</span>
    </div>}

    <div className="cinema-room-filters" role="group" aria-label="Filter rooms">
      {FILTERS.map((option) => <button key={option.id} type="button" aria-pressed={filter === option.id} className={filter === option.id ? "is-active" : ""} onClick={() => { setFilter(option.id); setOffset(0); }}>{option.label}</button>)}
    </div>
    <form className="cinema-room-search" role="search" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearchQuery(query); }}>
      <label htmlFor="cinema-room-query">Find a room</label>
      <div><MagnifyingGlass size={18} aria-hidden /><input id="cinema-room-query" type="search" value={query} maxLength={60} placeholder="Search title, host, or room ID" onChange={(event) => setQuery(event.target.value)} /></div>
      <button type="submit">Search</button>
    </form>

    {!rooms
      ? <p className="console-empty" role="status"><CircleNotch size={15} className="console-spin" aria-hidden /> Reading the rooms…</p>
      : rooms.length === 0
      ? <p className="console-empty">No rooms match this view. Try another status or search.</p>
      : <div className="cinema-rooms-table-wrap"><table className="console-table cinema-rooms-table">
        <thead><tr><th>Room</th><th>Host</th><th>People</th><th>Status</th><th>Started</th><th/></tr></thead>
        <tbody>
          {rooms.map((room) => <tr key={room.id}>
            <td data-label="Room">
              <button type="button" className="cinema-room-inspect-link" onClick={() => openInspect(room.id)} title="Inspect room details">
                <strong>{room.title}</strong>
              </button>
              <small>ID {room.id.slice(0, 8)} · created {when(room.createdAt)}</small>
            </td>
            <td data-label="Host"><strong>{room.hostName}</strong><small>ID {room.hostStudentId.slice(0, 8)}</small></td>
            <td data-label="People"><span className="cinema-room-people"><Users size={15} aria-hidden /> {room.memberCount}</span>{room.joinLocked ? <small>Locked</small> : null}{room.visibility === "PRIVATE" ? <small>Invite only</small> : null}</td>
            <td data-label="Status"><span className={`console-badge console-badge-${statusBadge(room.status)}`}>{room.status === "EXPIRED" ? "Cleanup pending" : room.status === "CREATED" ? "Open" : room.status === "LIVE" ? "Live" : "Ended"}</span></td>
            <td data-label="Started">{when(room.startedAt || room.createdAt)}{room.endedAt ? <small>Ended {when(room.endedAt)}</small> : null}</td>
            <td data-label="Action"><div className="console-row-actions">
              <button type="button" onClick={() => openInspect(room.id)} title="Inspect room"><Eye size={14} aria-hidden /> Inspect</button>
              {room.status === "CREATED" || room.status === "LIVE"
                ? confirmed === room.id
                  ? <>
                    <button type="button" className="console-danger" disabled={busy === room.id} onClick={() => void endRoom(room.id, room.title)}>
                      {busy === room.id ? <CircleNotch size={14} className="console-spin" aria-hidden /> : <Square size={14} aria-hidden />} End it
                    </button>
                    <button type="button" disabled={busy === room.id} onClick={() => setConfirmed("")}>Cancel</button>
                  </>
                  : <button type="button" onClick={() => setConfirmed(room.id)}><Square size={14} aria-hidden /> End room</button>
                : <small>Ended</small>}
            </div></td>
          </tr>)}
        </tbody>
      </table></div>}
    {rooms && (offset > 0 || hasMore) && <nav className="cinema-room-pages" aria-label="Room pages"><button type="button" disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 25))}>Previous</button><span>Page {Math.floor(offset / 25) + 1}</span><button type="button" disabled={!hasMore || loading} onClick={() => setOffset(value => value + 25)}>Next</button></nav>}

    {/* Room Inspection Dialog */}
    <CinemaDialog
      open={Boolean(inspectRoomId)}
      title={roomDetail ? `Room: ${roomDetail.title}` : "Inspect room"}
      busy={loadingDetail}
      onClose={() => { setInspectRoomId(null); setRoomDetail(null); }}
    >
      {loadingDetail && <p className="console-empty"><CircleNotch size={15} className="console-spin" aria-hidden /> Loading room details…</p>}
      {!loadingDetail && roomDetail && (
        <div className="cinema-console-detail">
          <div className="cinema-console-meta-grid">
            <div><strong>Host:</strong> {roomDetail.hostName} ({roomDetail.hostEmail || "No email"})</div>
            <div><strong>Status:</strong> <span className={`console-badge console-badge-${statusBadge(roomDetail.status)}`}>{roomDetail.status}</span></div>
            <div><strong>Visibility:</strong> {roomDetail.visibility}</div>
            <div><strong>Join Lock:</strong> {roomDetail.joinLocked ? "Locked 🔒" : "Open 🔓"}</div>
            <div><strong>Video Source:</strong> {roomDetail.videoSourceType === "YOUTUBE" ? `YouTube (${roomDetail.videoId})` : `Upload (${roomDetail.upload?.originalFilename || roomDetail.videoId})`}</div>
            <div><strong>Created:</strong> {when(roomDetail.createdAt)}</div>
          </div>

          <div className="cinema-console-actions-strip">
            {["CREATED", "LIVE"].includes(roomDetail.status) && (
              <>
                <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void toggleLock(roomDetail.id, !roomDetail.joinLocked)}>
                  {roomDetail.joinLocked ? <><LockOpen size={14} aria-hidden /> Unlock Door</> : <><Lock size={14} aria-hidden /> Lock Door</>}
                </button>
                <button type="button" className="console-danger" disabled={Boolean(busy)} onClick={() => void endRoom(roomDetail.id, roomDetail.title)}>
                  <Square size={14} aria-hidden /> End Room
                </button>
              </>
            )}
          </div>

          {/* Participants */}
          <div className="cinema-console-section">
            <h4>Participants ({roomDetail.participants.length})</h4>
            {roomDetail.participants.length === 0 ? <p className="console-note">No participants joined yet.</p> : (
              <ul className="cinema-console-list">
                {roomDetail.participants.map((p) => (
                  <li key={p.studentId} className="cinema-console-list-item">
                    <div>
                      <strong>{p.displayName}</strong> <span className="console-badge">{p.role}</span>
                      <small>{p.email ? ` · ${p.email}` : ""} · joined {when(p.joinedAt)}</small>
                    </div>
                    {p.studentId !== roomDetail.hostStudentId && ["CREATED", "LIVE"].includes(roomDetail.status) && (
                      <button type="button" className="console-danger-subtle" disabled={busy === p.studentId} onClick={() => void kickParticipant(roomDetail.id, p.studentId)}>
                        <UserMinus size={13} aria-hidden /> Kick
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Recent Messages */}
          {roomDetail.recentMessages.length > 0 && (
            <div className="cinema-console-section">
              <h4>Recent Messages</h4>
              <ul className="cinema-console-list">
                {roomDetail.recentMessages.slice(-8).map((m) => (
                  <li key={m.id} className="cinema-console-list-item">
                    <div>
                      <strong>{m.senderName}:</strong> <span>{m.content}</span>
                      <small> · {when(m.createdAt)}</small>
                    </div>
                    <button type="button" className="console-danger-subtle" disabled={busy === m.id} onClick={() => void deleteMessage(roomDetail.id, m.id)}>
                      <Trash size={13} aria-hidden /> Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </CinemaDialog>

    <p className="console-note">Ending a room closes its sockets and refuses new joins; it does not delete anything. The chat and membership are purged by the retention job, and every end is audited against your account.</p>
  </section>;
}
