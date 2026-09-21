"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaChatMessage, CinemaClientMessage, CinemaPlaybackState, CinemaPresenceMember, CinemaServerMessage } from "@/lib/cinema-engine/protocol";

export type CinemaConnectionState = "connecting" | "live" | "offline" | "closed";

/** How often the client proves the socket is still answered, in milliseconds. */
const PING_MS = 45_000;
const RETRY_BASE_MS = 800;
const RETRY_MAX_MS = 15_000;
/** The window keeps the last hundred; the server replays fifty. */
const CHAT_KEEP = 100;

/**
 * The room's live connection.
 *
 * The socket is opened only once the page knows who the student is and that the
 * room is still open; when either stops being true the connection is closed and
 * left closed. A dropped socket — a Worker deploy, a sleeping laptop — is
 * retried with exponential backoff, because a deploy is exactly the moment the
 * room is supposed to survive, and a client that gives up on the first close
 * would turn every release into an outage for whoever was watching.
 *
 * Presence arrives from the server, never from this hook's own guess: whatever
 * the Durable Object last broadcast is what the list shows.
 */
export function useCinemaSocket(input: { roomId: string; enabled: boolean }) {
  const { roomId, enabled } = input;
  const [state, setState] = useState<CinemaConnectionState>(enabled ? "connecting" : "closed");
  const [members, setMembers] = useState<CinemaPresenceMember[]>([]);
  const [playback, setPlayback] = useState<CinemaPlaybackState | null>(null);
  const [messages, setMessages] = useState<CinemaChatMessage[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  /** Sends one frame if the room is listening; a closed socket drops it. */
  const send = useCallback((message: CinemaClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /** Chat travels the same socket as playback; a closed one drops it. */
  const sendChat = useCallback((message: string, atSeconds?: number | null) => {
    const content = message.trim();
    if (!content) return;
    send({
      type: "chat_message",
      message: content,
      ...(Number.isFinite(Number(atSeconds)) && Number(atSeconds) >= 0 ? { timestamp: Number(atSeconds) } : {}),
    });
  }, [send]);

  useEffect(() => {
    // Disabled is not a state the effect writes; it is derived at the return.
    // Writing it here would be a cascading render for a value React already
    // has in hand.
    if (!enabled) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let attempts = 0;
    // Set when the server says the room is over: a room that ended must not be
    // reconnected to, however the socket went down.
    let ended = false;

    const clearTimers = () => {
      if (retryTimer) clearTimeout(retryTimer);
      if (pingTimer) clearInterval(pingTimer);
      retryTimer = null;
      pingTimer = null;
    };

    const connect = () => {
      if (disposed || ended) return;
      // Only a retry announces itself; the first attempt is already
      // "connecting" from useState, and saying so synchronously from the
      // effect body would be the cascading update the rule warns about.
      if (attempts) setState("offline");
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const instance = new WebSocket(`${scheme}://${window.location.host}/api/cinema/sessions/${encodeURIComponent(roomId)}/ws`);
      socket = instance;
      socketRef.current = instance;

      instance.onopen = () => {
        if (socket !== instance) return;
        attempts = 0;
        setState("live");
        pingTimer = setInterval(() => {
          if (instance.readyState === WebSocket.OPEN) instance.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
      };

      instance.onmessage = (event) => {
        if (socket !== instance) return;
        if (typeof event.data !== "string") return;
        let message: CinemaServerMessage;
        try {
          message = JSON.parse(event.data) as CinemaServerMessage;
        } catch {
          return;
        }
        if (message.type === "presence") setMembers(message.members || []);
        if (message.type === "state") setPlayback(message.playback);
        if (message.type === "chat") setMessages((current) => {
          const incoming = message.message;
          // A reconnect replays the last fifty, and the page may already have
          // shown some of them; an id the window holds is not a new message.
          if (!incoming?.id || current.some((item) => item.id === incoming.id)) return current;
          const next = [...current, incoming];
          return next.length > CHAT_KEEP ? next.slice(-CHAT_KEEP) : next;
        });
        // A moderator removed a message: the open room drops it too, so the
        // screens and the replay agree about what the room now contains.
        if (message.type === "chat_removed") setMessages((current) => current.filter((item) => item.id !== message.id));
        if (message.type === "closed") {
          ended = true;
          setState("closed");
          setMembers([]);
          instance.close();
        }
      };

      instance.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        if (socket !== instance || disposed || ended) return;
        if (socketRef.current === instance) socketRef.current = null;
        setState("offline");
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempts) + Math.floor(Math.random() * 250);
        attempts += 1;
        retryTimer = setTimeout(connect, delay);
      };
      // An error is followed by a close, which owns the retry.
      instance.onerror = () => undefined;
    };

    connect();
    return () => {
      disposed = true;
      clearTimers();
      socket?.close();
      socketRef.current = null;
      socket = null;
    };
  }, [roomId, enabled]);

  return enabled
    ? { state, members, playback, messages, send, sendChat }
    : { state: "closed" as CinemaConnectionState, members: [], playback: null, messages: [] as CinemaChatMessage[], send, sendChat };
}
