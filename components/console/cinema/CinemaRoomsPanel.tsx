"use client";

import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Loader2, RefreshCw, Square, Users } from "lucide-react";

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
  const [confirmed, setConfirmed] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const search = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : "";
      const response = await fetch(`/api/console/cinema/sessions?status=${filter}${search}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { rooms?: ConsoleRoom[]; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error || "The rooms could not be loaded.");
      setRooms(data.rooms || []);
      setSummary(data.summary || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The rooms could not be loaded.");
    }
  }, [filter, query]);

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

  if (!rooms) return <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Reading the rooms…</p>;

  return <section className="console-panel">
    <h2><Clapperboard size={18} aria-hidden />Study rooms
      <button type="button" className="console-panel-close" onClick={() => void load()}><RefreshCw size={14} aria-hidden />Refresh</button>
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && !error && <div className="console-alert console-alert-ok" role="status">{notice}</div>}

    {summary && <div className="console-totals">
      <article><span>Live now</span><strong>{summary.live}</strong><small>Rooms with somebody in them.</small></article>
      <article><span>Open</span><strong>{summary.waiting}</strong><small>Created, not started.</small></article>
      <article><span>Listed</span><strong>{summary.listed}</strong><small>Under this filter.</small></article>
    </div>}

    <div className="console-toolbar">
      {FILTERS.map((option) => <button key={option.id} type="button" className={filter === option.id ? "is-active" : ""} onClick={() => setFilter(option.id)}>{option.label}</button>)}
    </div>
    <form className="console-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>Find a room
        <input type="text" value={query} maxLength={60} placeholder="Title, host name or room id" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <button type="submit" className="console-secondary">Search</button>
    </form>

    {rooms.length === 0
      ? <p className="console-empty">No rooms under this filter.</p>
      : <table className="console-table">
        <thead><tr><th>Room</th><th>Host</th><th>People</th><th>Status</th><th>Started</th><th/></tr></thead>
        <tbody>
          {rooms.map((room) => <tr key={room.id}>
            <td><strong>{room.title}</strong><small>{room.id.slice(0, 8)} · {when(room.createdAt)}</small></td>
            <td><strong>{room.hostName}</strong><small>{room.hostStudentId.slice(0, 8)}</small></td>
            <td><Users size={13} aria-hidden /> {room.memberCount}{room.joinLocked ? " · locked" : ""}{room.visibility === "PRIVATE" ? " · private" : ""}</td>
            <td><span className={`console-badge console-badge-${statusBadge(room.status)}`}>{room.status}</span></td>
            <td>{when(room.startedAt || room.createdAt)}{room.endedAt ? <small>ended {when(room.endedAt)}</small> : null}</td>
            <td><div className="console-row-actions">
              {room.status === "CREATED" || room.status === "LIVE"
                ? confirmed === room.id
                  ? <>
                    <button type="button" className="console-danger" disabled={busy === room.id} onClick={() => void endRoom(room)}>
                      {busy === room.id ? <Loader2 size={14} className="console-spin" aria-hidden /> : <Square size={14} aria-hidden />} End it
                    </button>
                    <button type="button" disabled={busy === room.id} onClick={() => setConfirmed("")}>Cancel</button>
                  </>
                  : <button type="button" onClick={() => setConfirmed(room.id)}><Square size={14} aria-hidden /> End room</button>
                : <small>Ended</small>}
            </div></td>
          </tr>)}
        </tbody>
      </table>}
    <p className="console-note">Ending a room closes its sockets and refuses new joins; it does not delete anything. The chat and membership are purged by the retention job, and every end is audited against your account.</p>
  </section>;
}
