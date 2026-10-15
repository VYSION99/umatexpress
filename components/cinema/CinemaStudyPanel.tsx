"use client";
import { useCallback, useEffect, useState } from "react";
import { DownloadSimple, Sparkle } from "@/components/ui/MaterialIcon";
import type { CinemaStudyPack } from "@/lib/cinema-engine/study";
import { downloadTextPdf } from "./pdf";

export function CinemaStudyPanel({ roomId, aiEnabled, roomEnded, canGenerate, onSeek, canSeek }: { roomId: string; aiEnabled: boolean; roomEnded: boolean; canGenerate: boolean; onSeek: (seconds: number) => void; canSeek: boolean }) {
  const [pack, setPack] = useState<CinemaStudyPack | null>(null); const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [tab, setTab] = useState<"chapters" | "notes" | "cards" | "questions">("chapters");
  const load = useCallback(async () => { try { const response = await fetch(`/api/cinema/sessions/${roomId}/study`, { credentials: "same-origin", cache: "no-store" }); const data = await response.json() as { pack?: CinemaStudyPack | null; error?: string }; if (!response.ok) throw new Error(data.error); setPack(data.pack || null); } finally { setLoaded(true); } }, [roomId]);
  useEffect(() => { queueMicrotask(() => void load().catch((e) => setError(e.message))); }, [load]);
  const generate = async () => { setBusy(true); setError(""); try { const response = await fetch(`/api/cinema/sessions/${roomId}/study`, { method: "POST", credentials: "same-origin" }); const data = await response.json() as { pack?: CinemaStudyPack; error?: string }; if (!response.ok) throw new Error(data.error); setPack(data.pack || null); return true; } catch (e) { setError(e instanceof Error ? e.message : "The study pack could not be generated."); return false; } finally { setBusy(false); } };
  useEffect(() => {
    if (!loaded || !canGenerate || !roomEnded || !aiEnabled || pack || busy) return;
    const key = `umatexpress.cinema.study.auto:${roomId}`;
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
    queueMicrotask(() => void generate().then((ok) => { if (!ok) window.sessionStorage.removeItem(key); }));
    // `generate` deliberately runs once per ended room in this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, canGenerate, roomEnded, aiEnabled, pack, busy, roomId]);
  const exportPdf = () => { if (!pack) return; downloadTextPdf(`umatexpress-study-${roomId.slice(0, 8)}.pdf`, "UMATeXPRESS Study Pack", [pack.summary, "", "CHAPTERS", ...pack.chapters.map((c) => `${time(c.atSeconds)} — ${c.title}: ${c.summary}`), "", "NOTES", ...pack.notes.map((n) => `• ${n}`), "", "FLASHCARDS", ...pack.flashcards.flatMap((c) => [`Q: ${c.front}`, `A: ${c.back}`]), "", "REVISION QUESTIONS", ...pack.questions.flatMap((q) => [`Q: ${q.question}`, `A: ${q.answer}`])]); };
  return <section className="cinema-study"><div className="cinema-presence-head"><h2><Sparkle size={17} /> Study intelligence</h2>{pack && <button className="secondary" onClick={exportPdf}><DownloadSimple size={14} /> PDF</button>}</div>
    {!aiEnabled ? <p className="cinema-note">The host has kept AI study tools off for this session.</p> : <><p className="cinema-note">The study assistant uses only this room&apos;s transcript and shared moments. Review generated material against the source.</p>{canGenerate ? <button disabled={busy} onClick={() => void generate()}>{busy ? "Building your study pack…" : pack ? "Regenerate study pack" : "Generate study pack"}</button> : !pack && <p className="cinema-note">The host or a co-host has not generated the shared study pack yet.</p>}</>}
    {pack && <><p className="cinema-study-summary">{pack.summary}</p><nav>{([['chapters','Chapters'],['notes','Notes'],['cards','Flashcards'],['questions','Questions']] as const).map(([id,label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>{tab === "chapters" && <ol>{pack.chapters.map((chapter) => <li key={`${chapter.atSeconds}-${chapter.title}`}><button disabled={!canSeek} onClick={() => onSeek(chapter.atSeconds)}>{time(chapter.atSeconds)}</button><span><strong>{chapter.title}</strong>{chapter.summary}</span></li>)}</ol>}{tab === "notes" && <ul>{pack.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}{tab === "cards" && <div className="cinema-flashcards">{pack.flashcards.map((card, i) => <details key={i}><summary>{card.front}</summary><p>{card.back}</p></details>)}</div>}{tab === "questions" && <div className="cinema-flashcards">{pack.questions.map((item, i) => <details key={i}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div>}</>}
    {error && <p className="cinema-error">{error}</p>}
  </section>;
}
function time(value: number) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
