"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClosedCaption, MagnifyingGlass, Microphone, Trash, UploadSimple } from "@/components/ui/MaterialIcon";
import type { CinemaTranscriptPrivacy, CinemaTranscriptSegment } from "@/lib/cinema-engine/transcripts";

type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

export function CinemaTranscriptPanel(input: { roomId: string; isHost: boolean; active: boolean; atSeconds: () => number; onSeek: (seconds: number) => void; canSeek: boolean; onPrivacy?: (privacy: CinemaTranscriptPrivacy) => void }) {
  const { roomId, onPrivacy } = input;
  const [privacy, setPrivacy] = useState<CinemaTranscriptPrivacy | null>(null);
  const [segments, setSegments] = useState<CinemaTranscriptSegment[]>([]);
  const [query, setQuery] = useState(""); const [listening, setListening] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const recognition = useRef<Recognition | null>(null); const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async (q = "") => { const response = await fetch(`/api/cinema/sessions/${roomId}/transcript${q ? `?q=${encodeURIComponent(q)}` : ""}`, { credentials: "same-origin", cache: "no-store" }); const data = await response.json() as { privacy?: CinemaTranscriptPrivacy; segments?: CinemaTranscriptSegment[]; error?: string }; if (!response.ok) throw new Error(data.error || "The transcript could not be read."); if (data.privacy) { setPrivacy(data.privacy); onPrivacy?.(data.privacy); } setSegments(data.segments || []); }, [roomId, onPrivacy]);
  useEffect(() => { queueMicrotask(() => void load().catch((e) => setError(e.message))); }, [load]);
  useEffect(() => { if (!privacy?.transcriptEnabled) return; const timer = setInterval(() => void load(query).catch(() => undefined), 4_000); return () => clearInterval(timer); }, [privacy?.transcriptEnabled, load, query]);
  useEffect(() => { if (!privacy?.transcriptEnabled) return; const timer = setTimeout(() => void load(query).catch((e) => setError(e.message)), 250); return () => clearTimeout(timer); }, [query, privacy?.transcriptEnabled, load]);
  useEffect(() => {
    if (privacy?.transcriptEnabled !== false || !recognition.current) return;
    recognition.current.stop();
    recognition.current = null;
    queueMicrotask(() => setListening(false));
  }, [privacy?.transcriptEnabled]);
  useEffect(() => () => recognition.current?.stop(), []);
  const savePrivacy = async (next: CinemaTranscriptPrivacy) => { setBusy(true); setError(""); try { const response = await fetch(`/api/cinema/sessions/${input.roomId}/transcript`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }); const data = await response.json() as { privacy?: CinemaTranscriptPrivacy; error?: string }; if (!response.ok) throw new Error(data.error); if (data.privacy) { setPrivacy(data.privacy); input.onPrivacy?.(data.privacy); } } catch (e) { setError(e instanceof Error ? e.message : "Privacy settings could not be saved."); } finally { setBusy(false); } };
  const postCaption = async (text: string) => { try { const response = await fetch(`/api/cinema/sessions/${input.roomId}/transcript`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, atSeconds: input.atSeconds(), source: "CALL" }) }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "That caption could not be saved."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "That caption could not be saved."); } };
  const start = () => {
    if (listening) { recognition.current?.stop(); setListening(false); return; }
    const Constructor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Constructor) { setError("Live captions are not supported by this browser. You can still import WebVTT captions."); return; }
    const instance = new Constructor(); instance.lang = privacy?.captionLanguage || "en-GH"; instance.continuous = true; instance.interimResults = false;
    instance.onresult = (event) => { for (let i = event.resultIndex; i < event.results.length; i += 1) if (event.results[i].isFinal) void postCaption(event.results[i][0].transcript); };
    instance.onerror = () => { setListening(false); setError("Live captions stopped because the browser could not hear the microphone."); };
    instance.onend = () => setListening(false); recognition.current = instance; instance.start(); setListening(true);
  };
  const importVtt = async (file?: File) => { if (!file) return; setBusy(true); try { const response = await fetch(`/api/cinema/sessions/${input.roomId}/transcript`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "IMPORT_VTT", content: await file.text() }) }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Captions could not be imported."); } finally { setBusy(false); } };
  const clearTranscript = async () => { if (!window.confirm("Clear every caption and transcript line from this session?")) return; setBusy(true); setError(""); try { const response = await fetch(`/api/cinema/sessions/${input.roomId}/transcript`, { method: "DELETE", credentials: "same-origin" }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "The transcript could not be cleared."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "The transcript could not be cleared."); } finally { setBusy(false); } };
  return <section className="cinema-transcript">
    <div className="cinema-presence-head"><h2><ClosedCaption size={17} /> Captions & transcript</h2>{privacy?.transcriptEnabled && <span className="cinema-chip">{segments.length} lines</span>}</div>
    {input.isHost && privacy && <div className="cinema-privacy-controls"><label><input type="checkbox" checked={privacy.transcriptEnabled} disabled={busy} onChange={(e) => void savePrivacy({ ...privacy, transcriptEnabled: e.target.checked })} /> Store captions and transcript</label><label><input type="checkbox" checked={privacy.aiStudyEnabled} disabled={busy} onChange={(e) => void savePrivacy({ ...privacy, aiStudyEnabled: e.target.checked })} /> Allow AI study tools</label><label>Delete transcript after <select value={privacy.retentionHours} onChange={(e) => void savePrivacy({ ...privacy, retentionHours: Number(e.target.value) })}><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></label><p className="cinema-note">Captions are off by default. Live recognition is provided by the member&apos;s browser and may use its speech service; members choose when to start it.</p></div>}
    {privacy?.transcriptEnabled ? <><div className="cinema-controls"><button type="button" className={listening ? "danger" : "secondary"} disabled={!input.active} onClick={start}><Microphone size={15} /> {listening ? "Stop my captions" : "Caption my microphone"}</button>{input.isHost && <><button type="button" className="secondary" disabled={busy} onClick={() => fileRef.current?.click()}><UploadSimple size={15} /> Import WebVTT</button><input ref={fileRef} hidden type="file" accept=".vtt,text/vtt" onChange={(e) => void importVtt(e.target.files?.[0])} /><button type="button" className="secondary" disabled={busy} onClick={() => void clearTranscript()}><Trash size={15} /> Clear</button></>}</div><label className="cinema-transcript-search"><MagnifyingGlass size={15} /><input value={query} placeholder="Search this transcript" onChange={(e) => setQuery(e.target.value)} /></label><ol>{segments.map((segment) => <li key={segment.id}><button type="button" disabled={!input.canSeek} onClick={() => input.onSeek(segment.atSeconds)}>{formatTime(segment.atSeconds)}</button><span><strong>{segment.speakerName}</strong>{segment.text}</span></li>)}</ol></> : <p className="cinema-note">The host has kept captions and transcript storage off for this session.</p>}
    {error && <p className="cinema-error" role="alert">{error}</p>}
  </section>;
}
function formatTime(value: number) { const minutes = Math.floor(value / 60); return `${minutes}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
