"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaChatMessage } from "@/lib/cinema-engine/protocol";
import { mergeCinemaChat } from "@/lib/cinema-engine/chat-state";

type Page = { messages: CinemaChatMessage[]; context: CinemaChatMessage[]; hasMore: boolean; before: number; after: number; through: number; error?: string };
export function useCinemaChatHistory(input: { roomId: string; enabled: boolean; connection: number; live: CinemaChatMessage[]; removed: string[] }) {
  const [messages, setMessages] = useState<CinemaChatMessage[]>([]);
  const [context, setContext] = useState<CinemaChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const messagesRef = useRef(messages);
  const removedRef = useRef(new Set<string>());
  const olderBusy = useRef(false);
  const initialized = useRef(false);
  const generation = useRef(0);
  const sessionAbort = useRef<AbortController | null>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const merge = useCallback((page: Pick<Page, "messages" | "context">) => {
    setMessages(current => mergeCinemaChat(current, page.messages, removedRef.current));
    setContext(current => mergeCinemaChat(current, page.context, removedRef.current));
  }, []);
  useEffect(() => {
    for (const id of input.removed) removedRef.current.add(id);
    merge({ messages: input.live, context: [] });
  }, [input.live, input.removed, merge]);
  const fetchPage = useCallback(async (params: URLSearchParams, signal?: AbortSignal) => {
    const response = await fetch(`/api/cinema/sessions/${input.roomId}/messages?${params}`, { credentials: "same-origin", cache: "no-store", signal });
    const page = await response.json() as Page;
    if (!response.ok) throw new Error(page.error || "Chat history could not be loaded.");
    return page;
  }, [input.roomId]);
  useEffect(() => {
    if (!input.enabled) return;
    const abort = new AbortController(); const epoch = ++generation.current;
    sessionAbort.current = abort;
    void (async () => {
      setLoading(true); setError("");
      try {
        const oldest = messagesRef.current.filter(message => message.sequence).reduce((minimum, message) => Math.min(minimum, message.sequence!), Infinity);
        if (!initialized.current || !Number.isFinite(oldest)) {
          const page = await fetchPage(new URLSearchParams(), abort.signal);
          if (abort.signal.aborted) return;
          initialized.current = true; merge(page); setHasOlder(page.hasMore);
          // Reconcile after the oldest row in the snapshot, including messages
          // received on the socket while the first history request was pending.
        } else {
          let after = oldest - 1; let through: number | undefined;
          while (true) {
            const params = new URLSearchParams({ after: String(after), ...(through !== undefined ? { through: String(through) } : {}) });
            const page = await fetchPage(params, abort.signal);
            if (abort.signal.aborted) return;
            merge(page); through ??= page.through;
            if (!page.hasMore || page.after <= after) break;
            after = page.after;
          }
        }
      } catch (problem) { if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : "Chat history could not be loaded."); }
      finally { if (generation.current === epoch) setLoading(false); }
    })();
    return () => { abort.abort(); };
  }, [input.enabled, input.connection, retry, fetchPage, merge]);
  const loadOlder = useCallback(async () => {
    if (olderBusy.current) return;
    const before = messagesRef.current.filter(message => message.sequence).reduce((minimum, message) => Math.min(minimum, message.sequence!), Infinity);
    if (!Number.isFinite(before)) return;
    const epoch = generation.current; const signal = sessionAbort.current?.signal; olderBusy.current = true; setLoading(true); setError("");
    try {
      const page = await fetchPage(new URLSearchParams({ before: String(before) }), signal);
      if (generation.current !== epoch || signal?.aborted) return;
      merge(page); setHasOlder(page.hasMore);
    } catch (problem) { if (generation.current === epoch && !signal?.aborted) setError(problem instanceof Error ? problem.message : "Older messages could not be loaded."); }
    finally { olderBusy.current = false; if (generation.current === epoch && !signal?.aborted) setLoading(false); }
  }, [fetchPage, merge]);
  const retryHistory = useCallback(() => setRetry(value => value + 1), []);
  return { messages, context, hasOlder, loading, error, loadOlder, retry: retryHistory, fetchPage, merge };
}
