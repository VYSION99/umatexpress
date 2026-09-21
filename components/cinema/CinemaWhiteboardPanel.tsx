"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CinemaPlaybackState } from "@/lib/cinema-engine/protocol";
import { expectedPosition } from "@/lib/cinema-engine/sync";
import type { CinemaWhiteboardView } from "@/lib/cinema-engine/whiteboard-scene";
import { WhiteboardScene } from "./WhiteboardScene";

type WhiteboardLimits = {
  enabled: boolean;
  generationsPerHour: number;
  modes: string[];
  maxQuestionChars: number;
};

/**
 * The room's AI whiteboard.
 *
 * Asking is a request to the Worker, which builds the scene and tells the
 * room's Durable Object; the board this screen shows may have arrived from the
 * socket (someone asked) or from the room's history (someone just walked in).
 * The two are merged by id rather than synced, so a reconnect or a second
 * asker never doubles a board.
 *
 * The panel owns only its question and which historical board is on screen.
 * Everything it draws has already been parsed and bounded by the engine.
 */
export function CinemaWhiteboardPanel(input: {
  roomId: string;
  selfId: string;
  isHost: boolean;
  /** The room is open, so asking is allowed. */
  active: boolean;
  /** The room's socket is live; only then does an ask reach the room instantly. */
  connected: boolean;
  /** The newest board the socket announced, or null. */
  board: CinemaWhiteboardView | null;
  /** Board ids the socket saw removed, newest last. */
  removedIds: string[];
  /** The room's playback, so a question can say where the video was. */
  playback: CinemaPlaybackState | null;
}) {
  const { roomId, selfId, isHost, active, connected, board, removedIds, playback } = input;
  const [history, setHistory] = useState<CinemaWhiteboardView[]>([]);
  const [limits, setLimits] = useState<WhiteboardLimits | null>(null);
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("AUTO");
  const [browse, setBrowse] = useState(0);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/whiteboard`, { credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { boards?: CinemaWhiteboardView[]; limits?: WhiteboardLimits; error?: string };
        if (disposed) return;
        if (!response.ok) throw new Error(data.error || "The whiteboard could not be read.");
        setHistory(data.boards ?? []);
        setLimits(data.limits ?? null);
      } catch (readError) {
        if (!disposed) setError(readError instanceof Error ? readError.message : "The whiteboard could not be read.");
      }
    })();
    return () => { disposed = true; };
  }, [roomId]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Read the playhead here rather than during render: a clock is read at
      // the moment the question is asked, not on every repaint.
      const at = playback ? Math.round(expectedPosition(playback, Date.now())) : 0;
      const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/whiteboard`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, mode, ...(at > 0 ? { atSeconds: at } : {}) }),
      });
      const data = await response.json() as { board?: CinemaWhiteboardView; error?: string };
      if (!response.ok) throw new Error(data.error || "The whiteboard could not answer that.");
      if (data.board) {
        const asked = data.board;
        setHistory((current) => [asked, ...current.filter((item) => item.id !== asked.id)]);
        setBrowse(0);
      }
      setQuestion("");
      setNotice("The board is on its way to everyone in the room.");
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "The whiteboard could not answer that.");
    } finally {
      setBusy(false);
    }
  }, [question, mode, roomId, playback]);

  const clear = useCallback(async (boardId: string) => {
    setClearing(boardId);
    setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/whiteboard?boardId=${encodeURIComponent(boardId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That board could not be cleared.");
      setHistory((current) => current.filter((item) => item.id !== boardId));
      setBrowse(0);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "That board could not be cleared.");
    } finally {
      setClearing("");
    }
  }, [roomId]);

  // The socket's board leads, the fetched history follows; an id is only ever
  // shown once, and a removal hides the board in both places.
  const suppressed = new Set(removedIds);
  const boards: CinemaWhiteboardView[] = [];
  const seen = new Set<string>();
  if (board && !suppressed.has(board.id)) {
    boards.push(board);
    seen.add(board.id);
  }
  for (const item of history) {
    if (seen.has(item.id) || suppressed.has(item.id)) continue;
    boards.push(item);
    seen.add(item.id);
  }
  const index = boards.length ? Math.min(browse, boards.length - 1) : 0;
  const current = boards[index] ?? null;
  const canClear = Boolean(current) && Boolean(current && (isHost || current.requesterId === selfId));
  const off = Boolean(limits && !limits.enabled);
  const canAsk = active && connected && !off && !busy && question.trim().length > 0;

  return <section className="cinema-card cinema-whiteboard">
    <div className="cinema-presence-head">
      <h2>AI whiteboard</h2>
      {limits && <span className={`cinema-link ${limits.enabled ? "is-live" : ""}`}>
        {limits.enabled ? `${limits.generationsPerHour} per hour` : "Off"}
      </span>}
    </div>
    <p className="cinema-note">
      The board sees this room — its title, where the video is and the last few chat lines — and answers with
      text, maths, code, diagrams or a simulated lab. It is a study aid: check what matters against your notes.
    </p>

    {!limits
      ? <p className="cinema-note cinema-sub">Checking what this room may ask…</p>
      : off
        ? <p className="cinema-note cinema-sub">The AI whiteboard is switched off on this deployment. Boards already asked for stay readable.</p>
        : active
          ? <form className="wb-ask" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
            <textarea
              value={question}
              maxLength={limits.maxQuestionChars}
              rows={3}
              placeholder="Ask for an explanation, a diagram, a derivation, a simulation…"
              aria-label="Ask the whiteboard"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="wb-ask-actions">
              <label className="wb-mode">
                <span>Format</span>
                <select value={mode} aria-label="Answer format" onChange={(event) => setMode(event.target.value)}>
                  {limits.modes.map((option) => <option key={option} value={option}>{option.toLowerCase()}</option>)}
                </select>
              </label>
              <button type="submit" disabled={!canAsk}>
                <Sparkles size={15} aria-hidden /> {busy ? "Thinking…" : "Ask"}
              </button>
            </div>
            <p className="cinema-note cinema-sub">
              {connected
                ? playback ? "Context: where the video is playing, and the room's last messages." : "Context: the room's title and its last messages."
                : "The room connection is down; asking returns when it reconnects."}
            </p>
          </form>
          : <p className="cinema-note cinema-sub">This room has ended, so no new boards can be asked for. Earlier boards are still here.</p>}

    {error && <p className="cinema-error cinema-sub">{error}</p>}
    {notice && <p className="cinema-report-notice">{notice}</p>}

    {current
      ? <>
        <div className="wb-history">
          <button type="button" className="secondary" disabled={index >= boards.length - 1} onClick={() => setBrowse(Math.min(index + 1, boards.length - 1))}>Older</button>
          <span>Board {index + 1} of {boards.length}</span>
          <button type="button" className="secondary" disabled={index <= 0} onClick={() => setBrowse(Math.max(index - 1, 0))}>Newer</button>
          {canClear && <button
            type="button"
            className="secondary wb-clear"
            disabled={clearing === current.id}
            onClick={() => void clear(current.id)}
          >{clearing === current.id ? "Clearing…" : "Clear"}</button>}
        </div>
        <p className="cinema-note wb-meta">
          Asked by {current.requesterName || "a member"}
          {current.atSeconds ? ` at ${clock(current.atSeconds)}` : ""} · {current.topic.toLowerCase()} · {stamp(current.createdAt)}
        </p>
        <WhiteboardScene scene={current} />
      </>
      : limits && !off && <p className="cinema-note cinema-sub">No board yet. The first question opens it.</p>}
  </section>;
}

/** 320 seconds reads as 05:20, like the chat chips. */
function clock(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** ISO in, "21 Sep 14:05" out; an unreadable stamp shows nothing. */
function stamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
