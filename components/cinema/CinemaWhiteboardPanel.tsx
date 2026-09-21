"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaBoardPolicy, CinemaPlaybackState } from "@/lib/cinema-engine/protocol";
import { expectedPosition } from "@/lib/cinema-engine/sync";
import type { CinemaWhiteboardView } from "@/lib/cinema-engine/whiteboard-scene";
import { WhiteboardScene } from "./WhiteboardScene";

type WhiteboardLimits = {
  enabled: boolean;
  generationsPerHour: number;
  modes: string[];
  maxQuestionChars: number;
  /** How often an automatic room asks for its next summary, in minutes. */
  autoMinutes: number;
};

/** The host's three rules, in the order they open the room up. */
const POLICY_CHOICES: Array<{ value: CinemaBoardPolicy; label: string; title: string }> = [
  { value: "HOST", label: "Host only", title: "Only you may ask" },
  { value: "MEMBERS", label: "Everyone", title: "Anyone in the room may ask" },
  { value: "AUTO", label: "Automatic", title: "The room answers and summarises on its own" },
];

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
 *
 * Who may ask is the host's switch, and it is enforced twice: this panel hides
 * or shows the form, and the route refuses a question the room's live policy
 * does not allow before it spends a model call. On `AUTO` the host's own screen
 * runs the passes on the console's cadence — the question is written in the
 * engine, never here — and each answer arrives as a toast in the room.
 */
export function CinemaWhiteboardPanel(input: {
  roomId: string;
  selfId: string;
  isHost: boolean;
  /** The room is open, so asking is allowed. */
  active: boolean;
  /** The room's socket is live; only then does an ask reach the room instantly. */
  connected: boolean;
  /** Who the host lets ask; the room's live rule. */
  boardPolicy: CinemaBoardPolicy;
  /** Ask the room to change it; only the host's frame is accepted. */
  onBoardPolicy: (policy: CinemaBoardPolicy) => void;
  /** The newest board the socket announced, or null. */
  board: CinemaWhiteboardView | null;
  /** Board ids the socket saw removed, newest last. */
  removedIds: string[];
  /** The room's playback, so a question can say where the video was. */
  playback: CinemaPlaybackState | null;
}) {
  const { roomId, selfId, isHost, active, connected, boardPolicy, onBoardPolicy, board, removedIds, playback } = input;
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

  // The playhead is read when a pass fires, not when the timer was armed; a ref
  // keeps the callback stable, so re-arming never resets the cadence.
  const playbackRef = useRef(playback);
  useEffect(() => { playbackRef.current = playback; }, [playback]);

  /**
   * One automatic pass: the host's screen asks the Worker to summarise, and the
   * board reaches the whole room through the socket. No question travels with
   * it — the engine writes that prompt — and a failed pass stays silent, because
   * a missed summary is not something the room should be shown an error about.
   */
  const runAutoSummary = useCallback(async () => {
    const at = playbackRef.current ? Math.round(expectedPosition(playbackRef.current, Date.now())) : 0;
    try {
      await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/whiteboard`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auto: true, ...(at > 0 ? { atSeconds: at } : {}) }),
      });
    } catch { /* the next pass tries again */ }
  }, [roomId]);

  const autoMinutes = limits?.autoMinutes ?? 10;
  const autoOn = isHost && active && connected && boardPolicy === "AUTO" && Boolean(limits?.enabled);

  // Only the host's screen runs the room's automatic passes: there is exactly
  // one host, and the route refuses an automatic ask from anybody else.
  useEffect(() => {
    if (!autoOn) return;
    const timer = setInterval(() => { void runAutoSummary(); }, Math.max(5, autoMinutes) * 60_000);
    return () => clearInterval(timer);
  }, [autoOn, autoMinutes, runAutoSummary]);

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
  /** Host-only and everyone are the two policies that leave the form open. */
  const mayAsk = boardPolicy !== "HOST" || isHost;
  const canAsk = active && connected && !off && mayAsk && !busy && question.trim().length > 0;

  return <section className="cinema-card cinema-whiteboard">
    <div className="cinema-presence-head">
      <h2>AI whiteboard</h2>
      {limits && <span className={`cinema-link ${limits.enabled ? "is-live" : ""}`}>
        {limits.enabled ? `${limits.generationsPerHour} per hour` : "Off"}
      </span>}
    </div>
    <p className="cinema-note">
      The board sees this room — its title, where the video is and the last few chat lines — and answers with
      text, maths, code, diagrams, charts, interactive graphs or a simulated lab. It is a study aid: check what matters against your notes.
    </p>

    {isHost && active && limits && !off && <div className="wb-policy">
      <span>Who may ask</span>
      <div className="wb-policy-options" role="group" aria-label="Who may ask the whiteboard">
        {POLICY_CHOICES.map((choice) => <button
          key={choice.value}
          type="button"
          className={boardPolicy === choice.value ? "is-on" : ""}
          aria-pressed={boardPolicy === choice.value}
          title={choice.title}
          disabled={!connected}
          onClick={() => onBoardPolicy(choice.value)}
        >{choice.label}</button>)}
      </div>
      {boardPolicy === "AUTO" && <span className="wb-policy-note">A summary every {autoMinutes} min</span>}
    </div>}

    {!limits
      ? <p className="cinema-note cinema-sub">Checking what this room may ask…</p>
      : off
        ? <p className="cinema-note cinema-sub">The AI whiteboard is switched off on this deployment. Boards already asked for stay readable.</p>
        : !active
          ? <p className="cinema-note cinema-sub">This room has ended, so no new boards can be asked for. Earlier boards are still here.</p>
          : boardPolicy === "AUTO"
            ? <p className="cinema-note cinema-sub">
              {isHost
                ? `The room is on automatic: it answers the chat and summarises the session every ${autoMinutes} minutes, and each summary arrives as a notice in the room. Nothing has to be typed.`
                : "The room is on automatic: it answers the chat and summarises the session on its own, and each summary arrives as a notice. The host can hand the questions back at any time."}
            </p>
            : !mayAsk
              ? <p className="cinema-note cinema-sub">The host keeps the questions in this room. The boards they ask for still reach everyone here.</p>
              : <form className="wb-ask" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
            <textarea
              value={question}
              maxLength={limits.maxQuestionChars}
              rows={3}
              placeholder="Ask for an explanation, a diagram, a derivation, a chart or a graph to explore…"
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
          </form>}

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
      : limits && !off && <p className="cinema-note cinema-sub">
        {boardPolicy === "AUTO" ? "No board yet. The first automatic pass opens it." : "No board yet. The first question opens it."}
      </p>}
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
