"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaAssistantJob } from "@/lib/cinema-engine/protocol";
export function useCinemaAssistant(input: { roomId: string; enabled: boolean; revision: number; questionIds: string; onAnswer: () => void }) {
  const { onAnswer } = input;
  const [jobs, setJobs] = useState<CinemaAssistantJob[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const alive = useRef(true);
  const loadGeneration = useRef(0);
  const previous = useRef(new Map<string, string>());
  const accept = useCallback((incoming: CinemaAssistantJob[]) => {
    let refresh = false;
    for (const job of incoming) {
      if ((job.status === "DONE" || job.status === "CANCELLED") && previous.current.get(job.id) !== job.status) refresh = true;
      previous.current.set(job.id, job.status);
    }
    setJobs(incoming); if (refresh) onAnswer();
  }, [onAnswer]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    const response = await fetch(`/api/cinema/sessions/${input.roomId}/assistant`, { credentials: "same-origin", cache: "no-store", signal });
    const data = await response.json() as { enabled?: boolean; jobs?: CinemaAssistantJob[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Ask Cinema status could not be loaded.");
    if (!alive.current || signal?.aborted || generation !== loadGeneration.current) return;
    setAiEnabled(data.enabled === true); accept(data.jobs || []);
  }, [input.roomId, accept]);
  useEffect(() => {
    alive.current = true;
    if (!input.enabled) return;
    const abort = new AbortController();
    void load(abort.signal).catch(problem => { if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : "Ask Cinema is unavailable."); });
    return () => { alive.current = false; abort.abort(); };
  }, [input.enabled, input.revision, input.questionIds, load]);
  const pending = jobs.some(job => job.status === "QUEUED" || job.status === "RUNNING");
  useEffect(() => {
    if (!input.enabled || !pending) return;
    const abort = new AbortController();
    const timer = setInterval(() => void load(abort.signal).catch(() => undefined), 4000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [input.enabled, pending, load]);
  const command = useCallback(async (id: string, cancel = false, retry = false) => {
    ++loadGeneration.current;
    setWorking(id); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${input.roomId}/assistant`, { method: cancel ? "DELETE" : "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: id, retry }) });
      const data = await response.json() as { job?: CinemaAssistantJob; error?: string };
      if (!response.ok) throw new Error(data.error || "The assistant request failed.");
      if (alive.current) { if (data.job) setJobs(current => [data.job!, ...current.filter(job => job.id !== id)]); await load(); }
    } catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : "The assistant request failed."); }
    finally { if (alive.current) setWorking(""); }
  }, [input.roomId, load]);
  return { jobs: new Map(jobs.map(job => [job.id, job])), aiEnabled, error, working, request: (id: string, retry = false) => command(id, false, retry), cancel: (id: string) => command(id, true) };
}
