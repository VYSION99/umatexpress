"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadSimple, Sparkle } from "@/components/ui/MaterialIcon";
import type { CinemaStudyJob, CinemaStudyPack } from "@/lib/cinema-engine/study";
import { matchesCinemaVideo, type CinemaVideoReference } from "@/lib/cinema-engine/video-reference";
import { downloadTextPdf } from "./pdf";

export function CinemaStudyPanel({ roomId, aiEnabled, roomEnded, canGenerate, onSeek, canSeek, video, revision = 0 }: { roomId: string; aiEnabled: boolean; roomEnded: boolean; canGenerate: boolean; onSeek: (seconds: number, video?: CinemaVideoReference) => void; canSeek: boolean; video?: { sourceType: string; videoId: string }; revision?: number }) {
  const [pack, setPack] = useState<CinemaStudyPack | null>(null); const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [tab, setTab] = useState<"chapters" | "notes" | "cards" | "questions">("chapters");
  const loadSequence = useRef(0);
  const [dataRevision, setDataRevision] = useState(revision);
  const autoAttempted = useRef(new Set<string>());
  const [job, setJob] = useState<CinemaStudyJob | null>(null);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/study`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { pack?: CinemaStudyPack | null; job?: CinemaStudyJob | null; error?: string };
      if (sequence !== loadSequence.current) return;
      if (!response.ok) throw new Error(data.error || "The study pack could not be loaded.");
      setPack(data.pack && (!data.pack.expiresAt || Date.parse(data.pack.expiresAt) > Date.now()) ? data.pack : null); setJob(data.job || null); setDataRevision(revision); setLoaded(true);
    } catch (problem) { if (sequence === loadSequence.current) throw problem; }
  }, [roomId, revision]);
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void load().catch((e) => setError(e.message)); });
    return () => { disposed = true; loadSequence.current += 1; };
  }, [load]);
  useEffect(() => {
    if (!aiEnabled) return;
    const active = job?.status === "QUEUED" || job?.status === "RUNNING";
    if (!active && !pack) return;
    const timer = setInterval(() => void load().catch(() => undefined), active ? 15_000 : 30_000);
    return () => clearInterval(timer);
  }, [aiEnabled, job?.status, pack, load]);
  useEffect(() => {
    if (!pack?.expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = Date.parse(pack.expiresAt!) - Date.now();
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
      setPack(null); void load().catch(() => undefined);
    };
    timer = setTimeout(expire, Math.max(0, Math.min(Date.parse(pack.expiresAt) - Date.now(), 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [pack, load]);
  const generate = async () => { setBusy(true); setError(""); try { const response = await fetch(`/api/cinema/sessions/${roomId}/study`, { method: "POST", credentials: "same-origin" }); const data = await response.json() as { job?: CinemaStudyJob; error?: string }; if (!response.ok) throw new Error(data.error); setJob(data.job || null); return true; } catch (e) { setError(e instanceof Error ? e.message : "The study pack could not be queued."); return false; } finally { setBusy(false); } };
  useEffect(() => {
    if (!loaded || !canGenerate || !roomEnded || !aiEnabled || pack || job || busy) return;
    const key = `umatexpress.cinema.study.auto:${roomId}`;
    if (autoAttempted.current.has(roomId)) return;
    autoAttempted.current.add(roomId);
    try { if (window.sessionStorage.getItem(key)) return; window.sessionStorage.setItem(key, "1"); } catch { /* the in-memory guard also supports blocked storage */ }
    // A failed attempt stays attempted. Retry requires the user's explicit
    // button press, rather than re-entering this effect when busy becomes false.
    queueMicrotask(() => void generate());
    // `generate` deliberately runs once per ended room in this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, canGenerate, roomEnded, aiEnabled, pack, job, busy, roomId]);
  const visiblePack = aiEnabled && dataRevision === revision ? pack : null;
  const exportPdf = () => { if (!visiblePack || (visiblePack.expiresAt && Date.parse(visiblePack.expiresAt) <= Date.now())) return; downloadTextPdf(`umatexpress-study-${roomId.slice(0, 8)}.pdf`, "UMATeXPRESS Study Pack", [visiblePack.summary, "", "CHAPTERS", ...visiblePack.chapters.map((c) => `${time(c.atSeconds)} — ${c.title}: ${c.summary}`), "", "NOTES", ...visiblePack.notes.map((n) => `• ${n}`), "", "FLASHCARDS", ...visiblePack.flashcards.flatMap((c) => [`Q: ${c.front}`, `A: ${c.back}`]), "", "REVISION QUESTIONS", ...visiblePack.questions.flatMap((q) => [`Q: ${q.question}`, `A: ${q.answer}`])]); };
  return <section className="cinema-study"><div className="cinema-presence-head"><h2><Sparkle size={17} /> Study intelligence</h2>{visiblePack && <button className="secondary" onClick={exportPdf}><DownloadSimple size={14} /> PDF</button>}</div>
    {!aiEnabled ? <p className="cinema-note">The host has kept AI study tools off for this session.</p> : <><p className="cinema-note">The study assistant uses only this room&apos;s transcript and shared moments. Review generated material against the source.</p>{canGenerate ? <button disabled={busy || job?.status === "QUEUED" || job?.status === "RUNNING"} onClick={() => void generate()}>{busy ? "Requesting…" : job?.status === "QUEUED" ? "Study pack queued" : job?.status === "RUNNING" ? "Building study pack…" : visiblePack ? "Regenerate study pack" : "Generate study pack"}</button> : !visiblePack && <p className="cinema-note">The host or a co-host has not generated the shared study pack yet.</p>}</>}
    {(job?.status === "QUEUED" || job?.status === "RUNNING") && <p className="cinema-note" role="status">{job.status === "QUEUED" ? "Your study pack is in the queue. Processing runs every five minutes and may take longer when other packs are ahead." : "Your study pack is being built. This page will update when it is ready."}</p>}
    {job?.status === "FAILED" && <p className="cinema-error" role="alert">{job.error || "The study pack could not be built."} {canGenerate && "You can try again."}</p>}
    {visiblePack && <><p className="cinema-study-summary">{visiblePack.summary}</p><nav>{([['chapters','Chapters'],['notes','Notes'],['cards','Flashcards'],['questions','Questions']] as const).map(([id,label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>{tab === "chapters" && <ol>{visiblePack.chapters.map((chapter) => <li key={`${chapter.atSeconds}-${chapter.title}`}><button disabled={!canSeek || !chapter.sourceKey || !matchesCinemaVideo(chapter.video, video)} title={!chapter.video ? "Original video is unknown" : !matchesCinemaVideo(chapter.video, video) ? "Moment from another video" : undefined} onClick={() => { if (chapter.sourceKey && matchesCinemaVideo(chapter.video, video)) onSeek(chapter.atSeconds, chapter.video); }}>{time(chapter.atSeconds)}</button><span><strong>{chapter.title}</strong>{chapter.summary}{!matchesCinemaVideo(chapter.video, video) && <small className="cinema-note">{chapter.video ? "Moment from another video" : "Original video is unknown"}</small>}</span></li>)}</ol>}{tab === "notes" && <ul>{visiblePack.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}{tab === "cards" && <div className="cinema-flashcards">{visiblePack.flashcards.map((card, i) => <details key={i}><summary>{card.front}</summary><p>{card.back}</p></details>)}</div>}{tab === "questions" && <div className="cinema-flashcards">{visiblePack.questions.map((item, i) => <details key={i}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div>}</>}
    {error && <p className="cinema-error">{error}</p>}
  </section>;
}
function time(value: number) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
