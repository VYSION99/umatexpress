"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaReaction } from "@/lib/cinema-engine/protocol";
import type { CinemaReactionEvent } from "./useCinemaSocket";

/** Update hints only: the audience never enters the speaking-stage presence. */
export function useCinemaAudienceUpdates(roomId: string, enabled: boolean) {
  const [questionsRevision, setQuestionsRevision] = useState(0);
  const [pollsRevision, setPollsRevision] = useState(0);
  const [reactions, setReactions] = useState<CinemaReactionEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const sendReaction = useCallback((emoji: CinemaReaction) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify({ type: "reaction", emoji }));
    return true;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let ended = false;
    let attempts = 0;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const connect = () => {
      if (disposed || ended) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const current = new WebSocket(`${scheme}://${window.location.host}/api/cinema/sessions/${encodeURIComponent(roomId)}/ws?audience=1`);
      socket = current;
      socketRef.current = current;
      current.onopen = () => {
        attempts = 0;
        setConnected(true);
        // A reconnect may have missed changes while offline.
        setQuestionsRevision((value) => value + 1);
        setPollsRevision((value) => value + 1);
      };
      current.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let frame: { type?: string; kind?: string; id?: string; from?: string; name?: string; emoji?: CinemaReaction; at?: number };
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === "interaction_changed") {
          if (frame.kind === "questions") setQuestionsRevision((value) => value + 1);
          if (frame.kind === "polls") setPollsRevision((value) => value + 1);
        }
        if (frame.type === "reaction" && frame.id && frame.emoji) {
          const reaction: CinemaReactionEvent = { id: frame.id, from: frame.from || "", name: frame.name || "Viewer", emoji: frame.emoji, at: frame.at || Date.now() };
          setReactions((current) => [...current, reaction].slice(-6));
          const timer = setTimeout(() => { timers.delete(timer); setReactions((current) => current.filter((item) => item.id !== reaction.id)); }, 4_000);
          timers.add(timer);
        }
        if (frame.type === "closed") { ended = true; current.close(); }
      };
      current.onclose = () => {
        setConnected(false);
        if (socketRef.current === current) socketRef.current = null;
        if (disposed || ended || socket !== current) return;
        const delay = Math.min(15_000, 800 * 2 ** attempts) + Math.floor(Math.random() * 250);
        attempts += 1;
        retry = setTimeout(connect, delay);
      };
    };
    connect();
    return () => { disposed = true; if (retry) clearTimeout(retry); for (const timer of timers) clearTimeout(timer); timers.clear(); socket?.close(); socketRef.current = null; };
  }, [roomId, enabled]);

  return { questionsRevision, pollsRevision, reactions, connected: enabled && connected, sendReaction };
}
