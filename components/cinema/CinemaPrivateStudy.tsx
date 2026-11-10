"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaAssistantCitation, CinemaChatMessage, CinemaPrivateStudyRequest } from "@/lib/cinema-engine/protocol";
import { appendCinemaPersonalNotes } from "@/lib/cinema-engine/personal-notes";

export function CinemaPrivateStudy({ roomId, accountId, enabled, revision, anchor, video, removed, onClearAnchor, onShare, onOpenThread }: {
  roomId: string; accountId: string; enabled: boolean; revision: number; anchor: CinemaChatMessage | null;
  video?: CinemaChatMessage["video"]; removed: ReadonlySet<string>; onClearAnchor: () => void;
  onShare: (text: string) => void; onOpenThread: (id: string) => void;
}) {
  const [requests, setRequests] = useState<CinemaPrivateStudyRequest[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false); const [draft, setDraft] = useState(anchor ? "Explain this message simply and give an example supported by the room sources." : "");
  const [linked, setLinked] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({}); const [now, setNow] = useState(() => Date.now());
  const [source, setSource] = useState<(CinemaAssistantCitation & { text: string; requestId: string }) | null>(null);
  const [sourceBusy, setSourceBusy] = useState("");
  const alive = useRef(true), generation = useRef(0);
  const delivery = useRef<{ key: string; body: { requestId: string; question: string; anchorId?: string; linkVideo: boolean; video?: CinemaChatMessage["video"] } } | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    const response = await fetch(`/api/cinema/sessions/${roomId}/private-study`, { credentials: "same-origin", cache: "no-store", signal, headers: { "x-cinema-account": accountId } });
    const data = await response.json() as { enabled?: boolean; requests?: CinemaPrivateStudyRequest[]; error?: string };
    if (!alive.current || signal?.aborted || generation.current !== current) return;
    if (!response.ok) {
      if ([401, 403, 409].includes(response.status)) { setRequests([]); setSource(null); setAiEnabled(false); }
      throw new Error(data.error || "Private explanations could not be loaded.");
    }
    setAiEnabled(data.enabled === true); setRequests(data.requests || []);
  }, [roomId, accountId]);
  useEffect(() => {
    alive.current = true; if (!enabled) return;
    const abort = new AbortController();
    queueMicrotask(() => { if (!abort.signal.aborted) void load(abort.signal).catch(problem => { if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : "Private study is unavailable."); }); });
    return () => { alive.current = false; abort.abort(); };
  }, [enabled, revision, load]);
  const pending = requests.some(request => ["QUEUED", "RUNNING"].includes(request.status));
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController(); const timer = setInterval(() => void load(abort.signal).catch(() => undefined), pending ? 4000 : 30000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { abort.abort(); clearInterval(timer); clearInterval(clock); };
  }, [enabled, pending, load]);
  const anchorId = anchor?.id;
  useEffect(() => { if (anchorId) queueMicrotask(() => setDraft(current => current || "Explain this message simply and give an example supported by the room sources.")); }, [anchorId]); // Preserve a private draft when the source changes.
  const command = async (method: string, body: Record<string, unknown>, busyId: string) => {
    setBusy(busyId); setError(""); setNotice(""); ++generation.current;
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/private-study`, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-cinema-account": accountId }, body: JSON.stringify(body) });
      const data = await response.json() as { request?: CinemaPrivateStudyRequest; error?: string };
      if (!response.ok) throw new Error(data.error || "That private request could not be saved.");
      if (!alive.current) return false;
      if (data.request) setRequests(current => [data.request!, ...current.filter(request => request.id !== data.request!.id)]);
      if (method === "DELETE") setRequests(current => current.filter(request => request.id !== body.requestId));
      await load(); return true;
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "Private study is unavailable."); return false; }
    finally { if (alive.current) setBusy(""); }
  };
  const inspect = async (requestId: string, key: string) => {
    setSourceBusy(`${requestId}:${key}`); setSource(null); setError("");
    try {
      const params = new URLSearchParams({ request: requestId, key });
      const response = await fetch(`/api/cinema/sessions/${roomId}/private-study/sources?${params}`, { credentials: "same-origin", cache: "no-store", headers: { "x-cinema-account": accountId } });
      const data = await response.json() as { source?: CinemaAssistantCitation & { text: string }; error?: string };
      if (!response.ok || !data.source) throw new Error(data.error || "This source is unavailable.");
      if (alive.current) setSource({ ...data.source, requestId });
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "This source is unavailable."); }
    finally { if (alive.current) setSourceBusy(""); }
  };
  const anchorRemoved = Boolean(anchor && (anchor.removed || removed.has(anchor.id)));
  return <section className="cinema-private-study" aria-label="Private study">
    <h3>Private study</h3><p className="cinema-note">These questions and explanations are visible only to your account in the app and expire after 24 hours. Your question and selected room sources are sent to the configured AI service.</p>
    {anchor && <div className="cinema-private-anchor"><p>{anchorRemoved ? "This source message was removed." : `Explaining: ${anchor.content.slice(0, 120)}`}</p><button type="button" onClick={onClearAnchor}>Clear selected source</button></div>}
    <form className="cinema-private-form" onSubmit={event => {
      event.preventDefault(); if (busy || !draft.trim() || !aiEnabled || anchorRemoved) return;
      const key = JSON.stringify([draft, anchor?.id, linked]);
      if (delivery.current?.key !== key) delivery.current = { key, body: { requestId: crypto.randomUUID(), question: draft, anchorId: anchor?.id, linkVideo: linked, video: !anchor && linked ? video : undefined } };
      const body = delivery.current.body;
      void command("POST", body, "new").then(saved => { if (saved) { setDraft(current => current === body.question ? "" : current); delivery.current = null; } });
    }}>
      <label>Ask privately<textarea aria-label="Your private Cinema question" value={draft} maxLength={500} rows={3} disabled={Boolean(busy)} onChange={event => setDraft(event.target.value)} /></label>
      {!anchor && <label className="cinema-chat-link"><input type="checkbox" checked={linked} disabled={Boolean(busy)} onChange={event => setLinked(event.target.checked)} /> Use the current video’s room sources</label>}
      <button type="submit" disabled={Boolean(busy) || !draft.trim() || !aiEnabled || anchorRemoved}>{busy === "new" ? "Saving privately…" : "Ask privately"}</button>
      {!aiEnabled && <p className="cinema-note">The host has kept AI study and chat off.</p>}
    </form>
    <div className="cinema-private-requests" aria-label="Your private explanations">{requests.filter(request => Date.parse(request.expiresAt) > now).map(request => {
      const available = request.status === "DONE" && !removed.has(request.anchorId) && !request.dependencies.some(id => removed.has(id));
      return <article key={request.id} className="cinema-private-request" data-request-id={request.id}>
        <h4>{request.question}</h4>
        {available ? <><span className="cinema-ai-label">Private · AI-generated · Check the sources</span>
          <textarea readOnly aria-label="Private explanation answer" rows={5} value={request.answer} onSelect={event => { const excerpt = event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd); setSelected(current => ({ ...current, [request.id]: excerpt })); }} />
          <div className="cinema-ai-sources">{request.citations.map(citation => <button type="button" key={citation.key} disabled={Boolean(sourceBusy)} onClick={() => void inspect(request.id, citation.key)}>{sourceBusy === `${request.id}:${citation.key}` ? "Loading…" : `${citation.key} · ${citation.kind === "MESSAGE" ? "Message" : "Transcript"}`}</button>)}</div>
          {source?.requestId === request.id && <aside className="cinema-ai-source" aria-label="Private source evidence"><strong>{source.key} · Room source</strong><p>{source.text}</p><div className="cinema-private-actions">{source.kind === "MESSAGE" && <button type="button" onClick={() => onOpenThread(source.threadId || source.id)}>Open source conversation</button>}<button type="button" onClick={() => setSource(null)}>Close private source</button></div></aside>}
          <div className="cinema-private-actions"><button type="button" onClick={() => { setError(""); setNotice(""); try { appendCinemaPersonalNotes(window.localStorage, roomId, accountId, `Private AI explanation — ${request.question}\n${request.answer}`); setNotice("Explanation saved to your notes on this device."); } catch (problem) { setError(problem instanceof Error ? problem.message : "Your notes could not be saved on this device."); } }}>Save explanation to my notes</button>
            <button type="button" disabled={!selected[request.id]?.trim()} onClick={() => onShare(`Shared AI explanation: ${selected[request.id]}`)}>Review selected explanation for sharing</button></div>
        </> : <p role="status">{request.status === "QUEUED" ? "Private request queued…" : request.status === "RUNNING" ? "Preparing your private explanation…" : request.status === "DONE" ? "This explanation is unavailable because a source was removed." : request.error || "This private request is unavailable."}</p>}
        <div className="cinema-private-actions">
          {["QUEUED", "RUNNING"].includes(request.status) && <button type="button" disabled={Boolean(busy)} onClick={() => void command("PATCH", { requestId: request.id, action: "CANCEL" }, request.id)}>Cancel private request</button>}
          {request.status === "FAILED" && request.attempts < 3 && <button type="button" disabled={Boolean(busy)} onClick={() => void command("PATCH", { requestId: request.id, action: "RETRY" }, request.id)}>Retry private explanation</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void command("DELETE", { requestId: request.id }, request.id)}>Delete private request</button>
        </div>
      </article>;
    })}</div>
    {error && <p className="cinema-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
