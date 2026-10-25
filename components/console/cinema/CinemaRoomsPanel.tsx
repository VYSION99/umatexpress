"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, FilmSlate, MagnifyingGlass, Square, Users } from "@/components/ui/MaterialIcon";

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

/**
 * Every study room on the platform, the way the console shows every other
 * service's list. A moderator's one action here is ending a room, which is the
 * moderation action the platform already understands; the chat itself is read
 * through the report queue, not browsed from here.
 */
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

  async function endRoom(room: ConsoleRoom) {
    setBusy(room.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/console/cinema/sessions/${room.id}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "END_ROOM" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The room could not be ended.");
      setNotice(`"${room.title}" has ended. Everyone in it was told, and the room will not accept joins.`);
      await load();
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : "The room could not be ended.");
    } finally {
      setBusy("");
      setConfirmed("");
    }
  }

  return <section className="console-panel cinema-rooms-panel" aria-labelledby="cinema-rooms-heading">
    <div className="cinema-rooms-heading">
      <div>
        <span className="cinema-rooms-heading-icon"><FilmSlate size={20} aria-hidden /></span>
        <div><h2 id="cinema-rooms-heading">Room directory</h2><p>Monitor sessions and close a room when needed.</p></div>
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
            <td data-label="Room"><strong>{room.title}</strong><small>ID {room.id.slice(0, 8)} · created {when(room.createdAt)}</small></td>
            <td data-label="Host"><strong>{room.hostName}</strong><small>ID {room.hostStudentId.slice(0, 8)}</small></td>
            <td data-label="People"><span className="cinema-room-people"><Users size={15} aria-hidden /> {room.memberCount}</span>{room.joinLocked ? <small>Locked</small> : null}{room.visibility === "PRIVATE" ? <small>Invite only</small> : null}</td>
            <td data-label="Status"><span className={`console-badge console-badge-${statusBadge(room.status)}`}>{room.status === "EXPIRED" ? "Cleanup pending" : room.status === "CREATED" ? "Open" : room.status === "LIVE" ? "Live" : "Ended"}</span></td>
            <td data-label="Started">{when(room.startedAt || room.createdAt)}{room.endedAt ? <small>Ended {when(room.endedAt)}</small> : null}</td>
            <td data-label="Action"><div className="console-row-actions">
              {room.status === "CREATED" || room.status === "LIVE"
                ? confirmed === room.id
                  ? <>
                    <button type="button" className="console-danger" disabled={busy === room.id} onClick={() => void endRoom(room)}>
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
    <p className="console-note">Ending a room closes its sockets and refuses new joins; it does not delete anything. The chat and membership are purged by the retention job, and every end is audited against your account.</p>
  </section>;
}
