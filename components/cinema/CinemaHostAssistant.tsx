"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaAssistantCitation, CinemaChatMessage, CinemaHostAssistanceKind, CinemaHostDraft } from "@/lib/cinema-engine/protocol";
import { validateCinemaHostMessage, validateCinemaHostPoll } from "@/lib/cinema-engine/host-assistance-plan";

type Action = (id: string, action: string, fields?: Record<string, unknown>) => Promise<void>;
function DraftReview({ draft, busy, act, inspect, video }: { draft: CinemaHostDraft; busy: boolean; video?: CinemaChatMessage["video"]; act: Action; inspect: (id: string, key: string) => void }) {
  const proposal = draft.proposal!;
  const [question, setQuestion] = useState(proposal.kind === "POLL" ? proposal.question : "");
  const [options, setOptions] = useState(proposal.kind === "POLL" ? proposal.options : []);
  const [text, setText] = useState(proposal.kind === "PROMPT" ? proposal.text : "");
  const [reminders, setReminders] = useState(proposal.kind === "MODERATION" ? proposal.items.map(item => item.reminder) : []);
  const [error, setError] = useState("");
  const disabled = busy || draft.reviewStatus === "APPLIED";
  const earlierVideo = draft.scope?.video && (draft.scope.video.sourceType !== video?.sourceType || draft.scope.video.videoId !== video?.videoId);
  const submit = (fields: Record<string, unknown>) => {
    try { if (proposal.kind === "POLL") validateCinemaHostPoll(fields); else validateCinemaHostMessage(fields.text); setError(""); void act(draft.id, "APPLY", fields); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Review these fields."); }
  };
  const citations = (keys: string[]) => <div className="cinema-ai-sources" aria-label="Host suggestion sources">{keys.map(key => <button type="button" key={key} onClick={() => inspect(draft.id, key)}>{key} · Source</button>)}</div>;
  return <div className="cinema-host-review">
    <span className="cinema-ai-label">AI-generated · Host review required</span>
    {draft.scope && <p className="cinema-note">{draft.scope.sourceCount} shared sources · Snapshot at {new Date(draft.scope.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{draft.scope.video ? earlierVideo ? " · earlier video selection" : " · current video" : " · room-wide"}</p>}
    {proposal.kind === "POLL" ? <form onSubmit={event => { event.preventDefault(); submit({ question, options }); }}>
      <label>Poll question<input aria-label="Reviewed poll question" value={question} maxLength={240} disabled={disabled} onChange={event => setQuestion(event.target.value)} /></label>
      {options.map((option, index) => <div className="cinema-host-choice" key={index}><input aria-label={`Reviewed poll choice ${index + 1}`} value={option} maxLength={100} disabled={disabled} onChange={event => { const value = event.target.value; setOptions(current => current.map((entry, at) => at === index ? value : entry)); }} /><button type="button" disabled={disabled || options.length <= 2} onClick={() => setOptions(current => current.filter((_, at) => at !== index))}>Remove choice</button></div>)}
      <div className="cinema-private-actions"><button type="button" disabled={disabled || options.length >= 6} onClick={() => setOptions(current => [...current, ""])}>Add choice</button><button type="submit" disabled={disabled}>Open reviewed poll</button></div>{citations(proposal.citations)}
    </form> : proposal.kind === "PROMPT" ? <form onSubmit={event => { event.preventDefault(); submit({ text }); }}><label>Discussion prompt<textarea aria-label="Reviewed discussion prompt" rows={3} value={text} maxLength={500} disabled={disabled} onChange={event => setText(event.target.value)} /></label>{citations(proposal.citations)}<button type="submit" disabled={disabled}>Post reviewed prompt</button></form>
      : <div><p className="cinema-note">Suggestions for review. Read the full conversation before acting.</p>{!proposal.items.length && <p>No review items were suggested in this chat window.</p>}{proposal.items.map((item, index) => <div className="cinema-host-moderation-item" key={index}><p>{item.observation}</p>{citations(item.citations)}<label>Neutral room reminder<textarea aria-label={`Reviewed room reminder ${index + 1}`} rows={3} value={reminders[index]} maxLength={500} disabled={disabled} onChange={event => { const value = event.target.value; setReminders(current => current.map((entry, at) => at === index ? value : entry)); }} /></label><button type="button" disabled={disabled} onClick={() => submit({ text: reminders[index], itemIndex: index })}>Post reviewed reminder</button></div>)}</div>}
    {error && <p className="cinema-error" role="alert">{error}</p>}
  </div>;
}

export function CinemaHostAssistant({ roomId, accountId, revision, video, removed, onPublished, onOpenThread }: {
  roomId: string; accountId: string; revision: number; video?: CinemaChatMessage["video"]; removed: ReadonlySet<string>; onPublished: () => void; onOpenThread: (id: string) => void;
}) {
  const [drafts, setDrafts] = useState<CinemaHostDraft[]>([]), [enabled, setEnabled] = useState(false);
  const [kind, setKind] = useState<CinemaHostAssistanceKind>("POLL"), [brief, setBrief] = useState(""), [linked, setLinked] = useState(true);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [source, setSource] = useState<(CinemaAssistantCitation & { text: string; requestId: string }) | null>(null);
  const alive = useRef(true), generation = useRef(0), delivery = useRef<{ key: string; body: Record<string, unknown> } | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const epoch = ++generation.current;
    const response = await fetch(`/api/cinema/sessions/${roomId}/host-assistance`, { credentials: "same-origin", cache: "no-store", signal, headers: { "x-cinema-account": accountId } });
    const data = await response.json() as { drafts?: CinemaHostDraft[]; enabled?: boolean; error?: string };
    if (!alive.current || signal?.aborted || epoch !== generation.current) return;
    if (!response.ok) { if ([401, 403, 409].includes(response.status)) { setDrafts([]); setEnabled(false); setSource(null); } throw new Error(data.error || "Host suggestions could not be loaded."); }
    setDrafts(data.drafts || []); setEnabled(data.enabled === true);
  }, [roomId, accountId]);
  useEffect(() => {
    alive.current = true; const abort = new AbortController();
    queueMicrotask(() => { if (!abort.signal.aborted) void load(abort.signal).catch(problem => { if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : "Host suggestions are unavailable."); }); });
    return () => { alive.current = false; abort.abort(); };
  }, [load, revision]);
  const pending = drafts.some(draft => ["QUEUED", "RUNNING"].includes(draft.status));
  useEffect(() => {
    const abort = new AbortController(), timer = setInterval(() => void load(abort.signal).catch(() => undefined), pending ? 4000 : 30000), clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { abort.abort(); clearInterval(timer); clearInterval(clock); };
  }, [pending, load]);
  const command = async (method: string, body: Record<string, unknown>, id: string) => {
    setBusy(id); setError(""); setNotice(""); ++generation.current;
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/host-assistance`, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-cinema-account": accountId }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string; result?: { kind: string } };
      if (!response.ok) throw new Error(data.error || "The host action could not be completed.");
      if (!alive.current) return false;
      if (data.result) { setNotice(data.result.kind === "POLL" ? "Reviewed poll opened." : "Reviewed message posted to the room."); onPublished(); }
      await load(); return true;
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "The host action failed."); return false; }
    finally { if (alive.current) setBusy(""); }
  };
  const act: Action = async (id, action, fields = {}) => { await command("PATCH", { requestId: id, action, ...fields }, id); };
  const inspect = async (id: string, key: string) => {
    setSource(null); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${roomId}/host-assistance/sources?${new URLSearchParams({ request: id, key })}`, { credentials: "same-origin", cache: "no-store", headers: { "x-cinema-account": accountId } });
      const data = await response.json() as { source?: CinemaAssistantCitation & { text: string }; error?: string };
      if (!response.ok || !data.source) throw new Error(data.error || "This source is unavailable.");
      if (alive.current) setSource({ ...data.source, requestId: id });
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "This source is unavailable."); }
  };
  return <section className="cinema-host-assistant" aria-label="Host assistant"><h3>Host assistant</h3><p className="cinema-note">Only you can open these drafts while you are a host or co-host. Review the evidence and edit the suggestion before opening a poll or posting a message. Drafts expire after 24 hours.</p>
    <form className="cinema-host-request" onSubmit={event => {
      event.preventDefault(); if (busy || !enabled) return;
      const key = JSON.stringify([kind, brief, linked]);
      if (delivery.current?.key !== key) delivery.current = { key, body: { requestId: crypto.randomUUID(), kind, brief, linkVideo: linked, video: linked && kind !== "MODERATION" ? video : undefined } };
      const body = delivery.current.body;
      void command("POST", body, "new").then(saved => { if (saved) { setBrief(current => current === body.brief ? "" : current); delivery.current = null; } });
    }}><label>Suggestion type<select aria-label="Host suggestion type" value={kind} disabled={Boolean(busy)} onChange={event => setKind(event.target.value as CinemaHostAssistanceKind)}><option value="POLL">Poll draft</option><option value="PROMPT">Discussion prompt</option><option value="MODERATION">Moderation review</option></select></label>
      <label>Host brief (optional)<textarea aria-label="Host suggestion brief" rows={2} value={brief} maxLength={500} disabled={Boolean(busy)} onChange={event => setBrief(event.target.value)} /></label>
      {kind !== "MODERATION" ? <label className="cinema-chat-link"><input type="checkbox" checked={linked} disabled={Boolean(busy)} onChange={event => setLinked(event.target.checked)} /> Use current-video sources</label> : <p className="cinema-note">Reviews a bounded window of recent shared chat. Suggestions can prepare a neutral reminder.</p>}
      <button type="submit" disabled={Boolean(busy) || !enabled}>{busy === "new" ? "Saving request…" : "Suggest for my review"}</button>{!enabled && <p className="cinema-note">Enable AI study and chat to request suggestions.</p>}
    </form>
    <div className="cinema-host-drafts">{drafts.filter(draft => Date.parse(draft.expiresAt) > now).map(draft => {
      const valid = draft.status === "DONE" && !draft.dependencies.some(id => removed.has(id));
      return <article key={draft.id} className="cinema-host-draft" data-host-draft={draft.id}><h4>{({ POLL: "Poll draft", PROMPT: "Discussion prompt", MODERATION: "Moderation review" })[draft.kind]}</h4><p>{draft.brief}</p>
        {draft.reviewStatus === "APPLIED" && <p role="status">Applied after your review.</p>}
        {valid && draft.proposal ? <DraftReview draft={draft} video={video} busy={Boolean(busy)} act={act} inspect={(id, key) => void inspect(id, key)} /> : <p role="status">{draft.status === "DONE" ? "There is not enough available evidence for this suggestion." : draft.status === "QUEUED" ? "Suggestion queued…" : draft.status === "RUNNING" ? "Preparing a suggestion for your review…" : draft.error || "This suggestion is unavailable."}</p>}
        {source?.requestId === draft.id && valid && <aside className="cinema-ai-source" aria-label="Host source evidence"><strong>{source.key} · {source.kind === "MESSAGE" ? "Room message" : "Transcript"}</strong><p>{source.text}</p><div className="cinema-private-actions">{source.kind === "MESSAGE" && <button type="button" onClick={() => onOpenThread(source.threadId || source.id)}>Open evidence conversation</button>}<button type="button" onClick={() => setSource(null)}>Close host source</button></div></aside>}
        {draft.reviewStatus !== "APPLIED" && <div className="cinema-private-actions">{["QUEUED", "RUNNING"].includes(draft.status) && <button type="button" disabled={Boolean(busy)} onClick={() => void act(draft.id, "CANCEL")}>Cancel suggestion</button>}{draft.status === "FAILED" && draft.attempts < 3 && <button type="button" disabled={Boolean(busy)} onClick={() => void act(draft.id, "RETRY")}>Retry suggestion</button>}<button type="button" disabled={Boolean(busy)} onClick={() => void act(draft.id, "DISMISS")}>Dismiss suggestion</button></div>}
      </article>;
    })}</div>{error && <p className="cinema-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
