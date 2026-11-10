"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Flag, PaperPlaneTilt } from "@/components/ui/MaterialIcon";
import type { CinemaChatMessage, CinemaChatOverviewMode } from "@/lib/cinema-engine/protocol";
import { mergeCinemaChat } from "@/lib/cinema-engine/chat-state";
import { useCinemaChatHistory } from "./useCinemaChatHistory";
import { CINEMA_OVERVIEW_REQUESTS, isCinemaAssistantRequest } from "@/lib/cinema-engine/chat-assistant-text";
import { useCinemaAssistant } from "./useCinemaAssistant";
import { CinemaHostAssistant } from "./CinemaHostAssistant";
import { CinemaPrivateStudy } from "./CinemaPrivateStudy";
import { CinemaShareReview, type CinemaPreparedShare } from "./CinemaShareReview";
import { CinemaAssistantAnswer } from "./CinemaAssistantAnswer";
import type { useCinemaSocket } from "./useCinemaSocket";

type Live = ReturnType<typeof useCinemaSocket>;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export function CinemaChatPanel(input: {
  roomId: string; accountId: string; enabled: boolean; live: Live;
  video?: CinemaChatMessage["video"]; timestamp: () => number | null; canSeek: boolean;
  onReport: (messageId: string) => void;
  canManage?: boolean;
  preparedShare?: CinemaPreparedShare | null; onShareUsed?: (id: string) => void;
}) {
  const history = useCinemaChatHistory({ roomId: input.roomId, enabled: input.enabled, connection: input.live.chatConnection, live: input.live.messages, removed: input.live.removedChatIds });
  const assistant = useCinemaAssistant({ roomId: input.roomId, enabled: input.enabled, revision: input.live.assistantRevision || 0,
    questionIds: history.messages.filter(message => isCinemaAssistantRequest(message.content) && !message.assistant).map(message => message.id).join(","), onAnswer: history.retry });
  const [hostOpen, setHostOpen] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [privateAnchor, setPrivateAnchor] = useState<CinemaChatMessage | null>(null);
  const [localShare, setLocalShare] = useState<CinemaPreparedShare | null>(null);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<CinemaChatMessage | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<CinemaChatMessage[]>([]);
  const [threadContext, setThreadContext] = useState<CinemaChatMessage[]>([]);
  const [threadBefore, setThreadBefore] = useState(0);
  const [threadOlder, setThreadOlder] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const [linked, setLinked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const request = useRef<{ key: string; id: string; text: string; timestamp: number | null; parentMessageId?: string; video?: CinemaChatMessage["video"] } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const follow = useRef(true);
  const anchor = useRef<number | null>(null);
  const threadEpoch = useRef(0);
  const threadAbort = useRef<AbortController | null>(null);
  const fetchThreadPage = history.fetchPage;
  const removed = new Set(input.live.removedChatIds);
  const shown = thread ? mergeCinemaChat(threadMessages, history.messages.filter(message => (message.threadId || message.id) === thread), removed) : history.messages;
  const lookup = new Map([...history.context, ...history.messages, ...threadContext, ...shown].map(message => [message.id, message]));
  useLayoutEffect(() => {
    const list = listRef.current; if (!list) return;
    if (anchor.current !== null) { list.scrollTop += list.scrollHeight - anchor.current; anchor.current = null; }
    else if (follow.current) list.scrollTop = list.scrollHeight;
  }, [shown.length, thread]);
  useEffect(() => {
    if (!thread || !input.enabled) return;
    const abort = new AbortController(); const epoch = ++threadEpoch.current;
    threadAbort.current = abort;
    void (async () => {
      setThreadBusy(true);
      try {
        const page = await fetchThreadPage(new URLSearchParams({ thread }), abort.signal);
        if (abort.signal.aborted) return;
        setThreadMessages(current => mergeCinemaChat(current, page.messages)); setThreadContext(page.context);
        setThreadBefore(page.before); setThreadOlder(page.hasMore);
      } catch (problem) { if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : "The thread could not be loaded."); }
      finally { if (threadEpoch.current === epoch) setThreadBusy(false); }
    })();
    return () => { abort.abort(); };
  }, [thread, input.enabled, input.live.chatConnection, fetchThreadPage]);
  const selectThread = (id: string) => {
    if (id !== thread) { setThreadMessages([]); setThreadContext([]); setThreadBefore(0); setThreadOlder(false); }
    follow.current = true; setThread(id); setError("");
  };
  const openThread = (message: CinemaChatMessage) => {
    selectThread(message.threadId || message.id); if (!message.removed) setReply(message);
  };
  const older = async () => {
    if (history.loading || threadBusy) return;
    anchor.current = listRef.current?.scrollHeight ?? null; follow.current = false;
    if (!thread) { await history.loadOlder(); return; }
    const epoch = threadEpoch.current; const signal = threadAbort.current?.signal; setThreadBusy(true);
    try {
      const page = await history.fetchPage(new URLSearchParams({ thread, before: String(threadBefore) }), signal);
      if (epoch !== threadEpoch.current || signal?.aborted) return;
      setThreadMessages(current => mergeCinemaChat(current, page.messages));
      setThreadContext(current => mergeCinemaChat(current, page.context)); setThreadBefore(page.before); setThreadOlder(page.hasMore);
    } catch (problem) { if (!signal?.aborted) setError(problem instanceof Error ? problem.message : "Older replies could not be loaded."); }
    finally { if (epoch === threadEpoch.current && !signal?.aborted) setThreadBusy(false); }
  };
  const jump = async (message: CinemaChatMessage) => {
    setOpening(message.id); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${input.roomId}/messages/${encodeURIComponent(message.id)}/seek`, { method: "POST", credentials: "same-origin" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "This moment could not be opened.");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "This moment could not be opened."); }
    finally { setOpening(""); }
  };
  const share = localShare || (input.preparedShare?.accountId === input.accountId ? input.preparedShare : null);
  const dismissShare = () => { if (!share) return; if (localShare?.id === share.id) setLocalShare(null); else input.onShareUsed?.(share.id); };
  const replyUnavailable = Boolean(reply && (removed.has(reply.id) || lookup.get(reply.id)?.removed));
  return <div className="cinema-chat-panel">
    <div className="cinema-presence-head"><h2>{thread ? "Conversation thread" : "Room chat"}</h2>{thread && <button type="button" onClick={() => { setThread(null); setReply(null); follow.current = true; }}>Back to room chat</button>}</div>
    {!input.enabled ? <p className="cinema-note">Join this room to read and send messages.</p> : <>
      {input.canManage && <button type="button" className="cinema-private-toggle" aria-expanded={hostOpen} onClick={() => setHostOpen(current => !current)}>{hostOpen ? "Close host assistant" : "Open host assistant"}</button>}
      {input.canManage && hostOpen && <CinemaHostAssistant roomId={input.roomId} accountId={input.accountId} revision={input.live.assistantRevision || 0} video={input.video} removed={removed} onPublished={history.retry} onOpenThread={id => { selectThread(id); setReply(null); }} />}
      <button type="button" className="cinema-private-toggle" aria-expanded={privateOpen} onClick={() => setPrivateOpen(current => !current)}>{privateOpen ? "Close private study" : "Open private study"}</button>
      {privateOpen && <CinemaPrivateStudy key={`${input.roomId}:${input.accountId}`} roomId={input.roomId} accountId={input.accountId} enabled={input.enabled} revision={input.live.assistantRevision || 0} anchor={privateAnchor} video={input.video} removed={removed} onClearAnchor={() => setPrivateAnchor(null)} onShare={text => setLocalShare({ id: crypto.randomUUID(), accountId: input.accountId, text, origin: "EXPLANATION" })} onOpenThread={id => { selectThread(id); setReply(null); }} />}
      {share && <CinemaShareReview key={share.id} share={share} blocked={busy || Boolean(draft.trim())} onDismiss={dismissShare} onPrepare={text => { if (busy || draft.trim()) return; setDraft(text); setLinked(false); setReply(null); setThread(null); setPrivateOpen(false); dismissShare(); }} />}
      {(thread ? threadOlder : history.hasOlder) && <button className="secondary" type="button" disabled={history.loading || threadBusy} onClick={() => void older()}>Load older {thread ? "replies" : "messages"}</button>}
      {(history.loading || threadBusy) && <p role="status">Loading conversation…</p>}
      {history.error && <p className="cinema-error" role="alert">{history.error} <button type="button" onClick={history.retry}>Retry history</button></p>}
      <ul className="cinema-messages" ref={listRef} aria-label={thread ? "Thread messages" : "Room messages"} onScroll={() => { const list = listRef.current; if (list) follow.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80; }}>
        {shown.map(message => {
          const parent = message.parentMessageId ? lookup.get(message.parentMessageId) : undefined;
          return <li key={message.id} className={`${message.senderId === input.accountId ? "is-mine" : ""}${message.parentMessageId ? " is-reply" : ""}`}>
            {message.removed ? <p className="cinema-note">Message removed</p> : <>
              {message.parentMessageId && <button type="button" className="cinema-reply-preview" onClick={() => openThread(parent || message)}>
                Reply to {parent && !parent.removed && !removed.has(parent.id) ? `${parent.senderName || "Member"}: ${parent.content.slice(0, 100)}` : "an unavailable message"}
              </button>}
              <header><strong>{message.assistant ? message.assistant.overview?.mode === "UNANSWERED" ? "Cinema · Chat digest" : "Cinema · AI assistant" : message.senderId === input.accountId ? "You" : message.senderName || "Member"}</strong>
                {message.atSeconds !== null && (message.video && input.canSeek ? <button type="button" className="cinema-timestamp" disabled={Boolean(opening)} title="Open this video and move the room to this moment" onClick={() => void jump(message)}>{opening === message.id ? "Opening…" : clock(message.atSeconds)} · {message.video.sourceType === "UPLOAD" ? "Uploaded video" : "YouTube"}</button> : <span className="cinema-timestamp is-static">{clock(message.atSeconds)}{!message.video && " · earlier reference"}</span>)}
                {message.senderId !== input.accountId && <button type="button" className="cinema-report-flag" aria-label="Report this message" onClick={() => input.onReport(message.id)}><Flag size={12} aria-hidden /></button>}
              </header>
              {message.aiAssisted && <span className="cinema-ai-label">AI-assisted · Host reviewed</span>}
              {message.assistant ? <CinemaAssistantAnswer roomId={input.roomId} message={message} job={assistant.jobs.get(message.assistant.jobId)} removed={removed} onOpenThread={id => { selectThread(id); setReply(null); }} /> : <p>{message.content}</p>}
              {!message.assistant && isCinemaAssistantRequest(message.content) && <div className="cinema-ai-job" role="status">
                {assistant.jobs.get(message.id) ? <>
                  <span>{({ QUEUED: "Cinema is queued…", RUNNING: "Cinema is checking the room’s sources…", DONE: "Cinema answered in this thread.", FAILED: assistant.jobs.get(message.id)!.error, CANCELLED: assistant.jobs.get(message.id)!.error || "Request cancelled." })[assistant.jobs.get(message.id)!.status]}</span>
                  {(message.senderId === input.accountId || input.canManage) && ["QUEUED", "RUNNING"].includes(assistant.jobs.get(message.id)!.status) && <button type="button" disabled={assistant.working === message.id} onClick={() => void assistant.cancel(message.id)}>Cancel request</button>}
                  {message.senderId === input.accountId && assistant.jobs.get(message.id)!.status === "FAILED" && assistant.jobs.get(message.id)!.attempts < 3 && <button type="button" disabled={assistant.working === message.id} onClick={() => void assistant.request(message.id, true)}>Retry answer</button>}
                </> : message.senderId === input.accountId && <button type="button" disabled={assistant.working === message.id} onClick={() => void assistant.request(message.id)}>Ask Cinema about this message</button>}
              </div>}
              <div className="cinema-message-actions"><button type="button" onClick={() => { setReply(message); setError(""); }}>Reply</button><button type="button" onClick={() => openThread(message)}>View thread</button>{!message.assistant && <button type="button" disabled={!assistant.aiEnabled} onClick={() => { setPrivateAnchor(message); setPrivateOpen(true); }}>Explain privately</button>}</div>
            </>}
          </li>;
        })}
      </ul>
      {!shown.length && !history.loading && <p className="cinema-note">No messages yet. Start a conversation about the video.</p>}
      {reply && <div className="cinema-chat-replying"><span>{replyUnavailable ? "The message you selected was removed." : `Replying to ${reply.senderName || "Member"}: ${reply.content.slice(0, 90)}`}</span><button type="button" onClick={() => { setReply(null); setThread(null); }}>Cancel reply</button></div>}
      <div className="cinema-ask-controls"><button type="button" disabled={!assistant.aiEnabled || busy} onClick={() => setDraft(current => isCinemaAssistantRequest(current) ? current : `@Cinema ${current}`)}>Ask Cinema</button><span>{assistant.aiEnabled ? "Mention @Cinema to request an answer from this room’s sources." : "The host has kept AI study and chat off."}</span></div>
      <div className="cinema-overview-controls" aria-label="Chat overviews">
        <div>{([["CATCH_UP", "Catch up"], ["REPEATED", "Repeated questions"], ["UNANSWERED", "Questions without replies"]] as const).map(([mode, label]) => <button type="button" key={mode} disabled={!assistant.aiEnabled || busy || Boolean(draft.trim())} title={draft.trim() ? "Send or clear your draft to request an overview" : "Prepare an overview request"} onClick={() => { setDraft(CINEMA_OVERVIEW_REQUESTS[mode as CinemaChatOverviewMode]); setReply(null); setThread(null); }}>{label}</button>)}</div>
        <p className="cinema-note">Overviews are posted to the room and use recent chat{linked && input.video ? " for the linked video" : " across the room"}.</p>
      </div>
      <form className="cinema-chat-form" onSubmit={event => {
        event.preventDefault(); if (busy || !draft.trim() || replyUnavailable) return;
        const key = JSON.stringify([draft, reply?.id, linked]);
        if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID(), text: draft, timestamp: linked && input.video ? input.timestamp() : null, parentMessageId: reply?.id, video: linked ? input.video : undefined };
        const message = request.current; setBusy(true); setError("");
        void input.live.sendChat(message.text, message.timestamp, message.id, { parentMessageId: message.parentMessageId, video: message.video }).then(sent => {
          if (isCinemaAssistantRequest(message.text) && sent?.id) void assistant.request(sent.id);
          setDraft(current => current === message.text ? "" : current); request.current = null;
          if (!thread) setReply(null); follow.current = true;
        }).catch(problem => setError(problem instanceof Error ? problem.message : "Delivery was not confirmed. Retry to check this message.")).finally(() => setBusy(false));
      }}>
        <input value={draft} maxLength={500} placeholder={input.live.state === "live" ? "Message the room…" : "Reconnecting…"} aria-label="Message the room" disabled={busy} onChange={event => setDraft(event.target.value)} />
        <button type="submit" aria-label="Send message" disabled={busy || replyUnavailable || !draft.trim() || input.live.state !== "live"}><PaperPlaneTilt size={15} aria-hidden /></button>
      </form>
      <label className="cinema-chat-link"><input type="checkbox" checked={linked} onChange={event => setLinked(event.target.checked)} disabled={busy} /> Link the current video and moment</label>
      {busy && <p role="status">Sending…</p>}
      {assistant.error && <p className="cinema-error" role="alert">{assistant.error}</p>}
      {error && <p className="cinema-error" role="alert">{error} Your text is kept until delivery is confirmed.</p>}
      <p className="cinema-note">Hosts and co-hosts can open a linked video and move the room to that moment. Presenters can seek within the current video.</p>
    </>}
  </div>;
}
