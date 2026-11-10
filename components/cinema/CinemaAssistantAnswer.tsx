"use client";
import { useState } from "react";
import type { CinemaAssistantCitation, CinemaAssistantJob, CinemaChatMessage } from "@/lib/cinema-engine/protocol";
export function CinemaAssistantAnswer({ roomId, message, job, removed, onOpenThread }: { roomId: string; message: CinemaChatMessage; job?: CinemaAssistantJob; removed: ReadonlySet<string>; onOpenThread?: (threadId: string) => void }) {
  const [source, setSource] = useState<(CinemaAssistantCitation & { text: string }) | null>(null);
  const [loading, setLoading] = useState(""); const [error, setError] = useState("");
  const assistant = message.assistant;
  if (!assistant) return null;
  if (job?.status === "CANCELLED" || removed.has(assistant.jobId) || assistant.dependencies?.some(id => removed.has(id)) || assistant.citations.some(citation => citation.kind === "MESSAGE" && removed.has(citation.id))) return <p className="cinema-note">This Cinema reply is unavailable because its request or a source was removed.</p>;
  const inspect = async (key: string) => {
    setLoading(key); setError(""); setSource(null);
    try {
      const params = new URLSearchParams({ job: assistant.jobId, key });
      const response = await fetch(`/api/cinema/sessions/${roomId}/assistant/sources?${params}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { source?: CinemaAssistantCitation & { text: string }; error?: string };
      if (!response.ok || !data.source) throw new Error(data.error || "The source is no longer available.");
      setSource(data.source);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The source could not be loaded."); }
    finally { setLoading(""); }
  };
  const sourceButtons = (citations: CinemaAssistantCitation[]) => <div className="cinema-ai-sources" aria-label="Answer sources">{citations.map(citation => <button type="button" key={citation.key} disabled={Boolean(loading)} onClick={() => void inspect(citation.key)}>{loading === citation.key ? "Loading…" : `${citation.key} · ${citation.kind === "MESSAGE" ? "Message" : "Transcript"}`}{citation.atSeconds !== null && ` · ${Math.floor(citation.atSeconds / 60)}:${String(Math.floor(citation.atSeconds % 60)).padStart(2, "0")}`}</button>)}</div>;
  const overview = assistant.overview;
  const time = overview && Number.isFinite(Date.parse(overview.scope.asOf)) ? new Date(overview.scope.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "request time";
  return <div className="cinema-assistant-answer">
    <span className="cinema-ai-label">{overview?.mode === "UNANSWERED" ? "Room digest" : "AI-generated"} · Check the sources</span>
    {overview && <div className="cinema-overview-heading"><h3>{({ CATCH_UP: "Catch-up summary", REPEATED: "Suggested question groups", UNANSWERED: "Questions without replies" })[overview.mode]}</h3>
      <p className="cinema-note">Snapshot at {time} · {overview.scope.includedMessages} {overview.mode === "CATCH_UP" ? "messages" : "detected questions"} used{overview.scope.video ? " for this video" : " across the room"}, drawn from the latest {overview.scope.scannedMessages} room chat entries.</p>
      {overview.scope.limited && <p className="cinema-note">Earlier messages are outside this overview’s window.</p>}
    </div>}
    <p>{message.content}</p>
    {overview ? <div className="cinema-overview-items" role="list">{overview.items.map((item, index) => <div key={index} className="cinema-overview-item" role="listitem">
      {overview.mode === "REPEATED" && <strong>{item.citations.length} questions</strong>}<p>{item.text}</p>
      {sourceButtons(assistant.citations.filter(citation => item.citations.includes(citation.key)))}
    </div>)}</div> : assistant.citations.length > 0 && sourceButtons(assistant.citations)}
    {overview?.mode === "UNANSWERED" && <p className="cinema-note">Reply counts describe direct thread replies. Open a conversation to check its progress.</p>}
    {source && <aside className="cinema-ai-source" aria-label="Source evidence"><strong>{source.key} · {source.kind === "MESSAGE" ? "Room message" : "Transcript passage"}</strong><p>{source.text}</p><div className="cinema-ai-source-actions">{source.kind === "MESSAGE" && onOpenThread && <button type="button" onClick={() => onOpenThread(source.threadId || source.id)}>Open conversation</button>}<button type="button" onClick={() => setSource(null)}>Close source</button></div></aside>}
    {error && <p className="cinema-error" role="alert">{error}</p>}
  </div>;
}
