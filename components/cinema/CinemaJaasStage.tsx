"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type JaasAccess = {
  domain: string;
  roomName: string;
  token: string;
  role: "HOST" | "COHOST" | "PRESENTER";
  expiresAt: string;
};

type JitsiApi = {
  addListener: (event: string, listener: (...args: unknown[]) => void) => void;
  executeCommand: (command: string, ...args: unknown[]) => void;
  getIFrame: () => HTMLIFrameElement;
  dispose: () => void;
};

type JitsiConstructor = new (domain: string, options: Record<string, unknown>) => JitsiApi;

declare global {
  interface Window { JitsiMeetExternalAPI?: JitsiConstructor }
}

let sdkPromise: Promise<void> | null = null;

function loadJaasSdk(domain: string, appId: string) {
  if (domain !== "8x8.vc") return Promise.reject(new Error("The managed-stage domain is not trusted."));
  if (!/^[A-Za-z0-9_-]+$/.test(appId)) return Promise.reject(new Error("The managed-stage application ID is invalid."));
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-cinema-jaas="true"]');
    const script = existing ?? document.createElement("script");
    const finish = () => window.JitsiMeetExternalAPI ? resolve() : reject(new Error("The managed-stage SDK did not load."));
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => reject(new Error("The managed-stage SDK could not be loaded.")), { once: true });
    if (!existing) {
      script.src = `https://${domain}/${encodeURIComponent(appId)}/external_api.js`;
      script.async = true;
      script.dataset.cinemaJaas = "true";
      document.head.appendChild(script);
    }
  }).catch((error) => { sdkPromise = null; throw error; });
  return sdkPromise;
}

function deviceSession(roomId: string) {
  const key = `cinema-jaas-device:${roomId}`;
  const existing = sessionStorage.getItem(key);
  if (existing && existing.length >= 16) return existing;
  const value = crypto.randomUUID();
  sessionStorage.setItem(key, value);
  return value;
}

export function CinemaJaasStage({ roomId, active }: { roomId: string; active: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  const api = useRef<JitsiApi | null>(null);
  const device = useRef("");
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState("Preparing the managed speaking stage…");

  const release = useCallback(() => {
    const current = api.current;
    api.current = null;
    if (current) {
      try { current.executeCommand("hangup"); } catch { /* already disconnected */ }
      try { current.dispose(); } catch { /* already disposed */ }
    }
    if (device.current) {
      void fetch(`/api/cinema/sessions/${roomId}/jaas`, {
        method: "DELETE",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceSessionId: device.current }),
      }).catch(() => undefined);
    }
  }, [roomId]);

  useEffect(() => {
    if (!active || !parent.current) { release(); return; }
    let cancelled = false;
    setStatus("loading");
    setMessage("Preparing the managed speaking stage…");
    device.current = deviceSession(roomId);

    const connect = async () => {
      const response = await fetch(`/api/cinema/sessions/${roomId}/jaas`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceSessionId: device.current }),
      });
      const data = await response.json() as { access?: JaasAccess; error?: string; message?: string };
      if (!response.ok || !data.access) throw new Error(data.error || data.message || "The managed stage is unavailable.");
      const access = data.access;
      const appId = access.roomName.split("/", 1)[0] || "";
      await loadJaasSdk(access.domain, appId);
      if (cancelled || !parent.current || !window.JitsiMeetExternalAPI) return;
      const conference = new window.JitsiMeetExternalAPI(access.domain, {
        roomName: access.roomName,
        parentNode: parent.current,
        jwt: access.token,
        width: "100%",
        height: "100%",
        configOverwrite: {
          prejoinConfig: { enabled: false },
          disableDeepLinking: true,
          startWithAudioMuted: true,
          startWithVideoMuted: true,
          toolbarButtons: ["microphone", "camera", "desktop", "participants-pane", "tileview", "hangup", "livestreaming", "settings", "select-background"],
        },
      });
      api.current = conference;
      const frame = conference.getIFrame();
      frame.allow = "camera; microphone; display-capture; fullscreen; autoplay; clipboard-write";
      frame.title = "UMATeXPRESS managed speaking stage";
      conference.addListener("videoConferenceJoined", () => { if (!cancelled) { setStatus("ready"); setMessage("Managed stage connected."); } });
      conference.addListener("videoConferenceLeft", () => { if (!cancelled) { setStatus("failed"); setMessage("You left the managed stage. Rejoin when you are ready."); } });
      conference.addListener("readyToClose", () => { if (!cancelled) { release(); setStatus("failed"); setMessage("The managed stage has closed."); } });
    };
    void connect().catch((error) => {
      if (!cancelled) { setStatus("failed"); setMessage(error instanceof Error ? error.message : "The managed stage could not connect."); }
    });
    return () => { cancelled = true; release(); };
  }, [active, attempt, release, roomId]);

  return <div className="cinema-jaas-stage" data-status={status}>
    <div className="cinema-jaas-frame" ref={parent} />
    {status !== "ready" && <div className="cinema-jaas-state" role={status === "failed" ? "alert" : "status"}>
      <strong>{status === "failed" ? "Managed stage unavailable" : "Connecting speakers"}</strong>
      <span>{message}</span>
      {status === "failed" && active && <button type="button" onClick={() => { release(); setAttempt((value) => value + 1); }}>Try again</button>}
    </div>}
  </div>;
}
