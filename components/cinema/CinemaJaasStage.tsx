"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CinemaMediaController } from "@/lib/cinema-engine/media-controller";
import { CinemaJaasAdapter, type CinemaJitsiApi } from "@/lib/cinema-engine/jaas-media";
import { CinemaStageLease, StageLeaseLostError } from "@/lib/cinema-engine/stage-lease";
import type { CinemaClientMessage } from "@/lib/cinema-engine/protocol";

type JaasAccess = {
  domain: string;
  roomName: string;
  token: string;
  role: "HOST" | "COHOST" | "PRESENTER";
  expiresAt: string;
  activeUntil: string;
};

type JitsiApi = CinemaJitsiApi & { getIFrame: () => HTMLIFrameElement };

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
    const script = document.createElement("script");
    const finish = (message?: string) => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (!message) { resolve(); return; }
      script.remove();
      reject(new Error(message));
    };
    const timeout = setTimeout(() => finish("The managed-stage SDK took too long to load."), 15_000);
    script.onload = () => finish(window.JitsiMeetExternalAPI ? undefined : "The managed-stage SDK did not load.");
    script.onerror = () => finish("The managed-stage SDK could not be loaded.");
    script.src = `https://${domain}/${encodeURIComponent(appId)}/external_api.js`;
    script.async = true;
    script.dataset.cinemaJaas = "true";
    try { document.head.appendChild(script); }
    catch { finish("The managed-stage SDK could not be loaded."); }
  }).catch((error) => { sdkPromise = null; throw error; });
  return sdkPromise;
}

function releaseDevice(roomId: string, deviceSessionId: string) {
  return fetch(`/api/cinema/sessions/${roomId}/jaas`, {
    method: "DELETE", credentials: "same-origin", keepalive: true,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSessionId }),
  }).catch(() => undefined);
}

export function CinemaJaasStage({ roomId, active, muteAllSignal = 0, send }: { roomId: string; active: boolean; muteAllSignal?: number; send: (message: CinemaClientMessage) => unknown }) {
  const parent = useRef<HTMLDivElement>(null);
  const api = useRef<JitsiApi | null>(null);
  const device = useRef("");
  const lease = useRef<CinemaStageLease | null>(null);
  const controller = useRef<CinemaMediaController | null>(null);
  const handledMute = useRef(muteAllSignal);
  const capture = useRef({ mic: false, camera: false, screen: false });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState("Preparing the managed speaking stage…");

  const release = useCallback(() => {
    lease.current?.dispose(); lease.current = null;
    const current = api.current;
    api.current = null;
    const mediaController = controller.current;
    controller.current = null;
    if (mediaController) {
      try { mediaController.dispose(); } catch { /* provider already disconnected */ }
    } else if (current) {
      try { current.executeCommand("hangup"); } catch { /* already disconnected */ }
      try { current.dispose(); } catch { /* already disposed */ }
    }
    capture.current = { mic: false, camera: false, screen: false };
    send({ type: "media_state", ...capture.current });
    const sessionId = device.current;
    device.current = "";
    if (sessionId) void releaseDevice(roomId, sessionId);
  }, [roomId, send]);

  useEffect(() => {
    if (!active || !parent.current) { release(); return; }
    let cancelled = false;
    setStatus("loading");
    setMessage("Preparing the managed speaking stage…");
    // A fresh ID fences delayed DELETEs from a previous join, including retries.
    const deviceSessionId = crypto.randomUUID();
    device.current = deviceSessionId;

    const connect = async () => {
      const response = await fetch(`/api/cinema/sessions/${roomId}/jaas`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceSessionId }),
      });
      const data = await response.json() as { access?: JaasAccess; error?: string; message?: string };
      if (!response.ok || !data.access) throw new Error(data.error || data.message || "The managed stage is unavailable.");
      if (cancelled) { void releaseDevice(roomId, deviceSessionId); return; }
      const access = data.access;
      const sessionLease = new CinemaStageLease({
        activeUntil: access.activeUntil,
        renew: async signal => {
          const response = await fetch(`/api/cinema/sessions/${roomId}/jaas`, {
            method: "PUT", credentials: "same-origin", cache: "no-store", signal,
            headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSessionId }),
          });
          const result = await response.json() as { lease?: { activeUntil: string }; error?: string };
          if ([401, 403, 404, 409].includes(response.status)) throw new StageLeaseLostError(result.error || "Your place on the stage is no longer active.");
          if (!response.ok || !result.lease) throw new Error("The stage session could not be renewed.");
          return result.lease;
        },
        onLost: reason => {
          if (cancelled) return;
          cancelled = true; release(); setStatus("failed"); setMessage(reason);
        },
      });
      lease.current = sessionLease; sessionLease.start();
      if (cancelled) return;
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
      const adapter = new CinemaJaasAdapter(conference, (kind, enabled) => {
        if (cancelled) return;
        controller.current?.syncDevice(kind, enabled);
        capture.current = { ...capture.current, [kind === "audio" ? "mic" : kind === "video" ? "camera" : "screen"]: enabled };
        send({ type: "media_state", ...capture.current });
      });
      controller.current = new CinemaMediaController(adapter, problem => {
        if (!cancelled) setMessage(problem instanceof Error ? problem.message : "The managed media command failed.");
      });
      const frame = conference.getIFrame();
      frame.allow = "camera; microphone; display-capture; fullscreen; autoplay; clipboard-write";
      frame.title = "UMATeXPRESS managed speaking stage";
      conference.addListener("videoConferenceJoined", () => { if (!cancelled) { setStatus("ready"); setMessage("Managed stage connected."); } });
      conference.addListener("videoConferenceLeft", () => { if (!cancelled) { cancelled = true; release(); setStatus("failed"); setMessage("You left the managed stage. Rejoin when you are ready."); } });
      conference.addListener("readyToClose", () => { if (!cancelled) { cancelled = true; release(); setStatus("failed"); setMessage("The managed stage has closed."); } });
    };
    void connect().catch((error) => {
      if (!cancelled) { cancelled = true; release(); setStatus("failed"); setMessage(error instanceof Error ? error.message : "The managed stage could not connect."); }
    });
    const checkLease = () => { lease.current?.check(); };
    window.addEventListener("pageshow", checkLease);
    document.addEventListener("visibilitychange", checkLease);
    return () => {
      cancelled = true; window.removeEventListener("pageshow", checkLease);
      document.removeEventListener("visibilitychange", checkLease); release();
    };
  }, [active, attempt, release, roomId, send]);

  useEffect(() => {
    if (!active || status !== "ready" || muteAllSignal === handledMute.current) return;
    handledMute.current = muteAllSignal;
    void controller.current?.mute();
  }, [active, status, muteAllSignal]);

  return <div className="cinema-jaas-stage" data-status={status}>
    <div className="cinema-jaas-frame" ref={parent} />
    {status === "ready" && message !== "Managed stage connected." && <p role="status">{message}</p>}
    {status !== "ready" && <div className="cinema-jaas-state" role={status === "failed" ? "alert" : "status"}>
      <strong>{status === "failed" ? "Managed stage unavailable" : "Connecting speakers"}</strong>
      <span>{message}</span>
      {status === "failed" && active && <button type="button" onClick={() => { release(); setAttempt((value) => value + 1); }}>Try again</button>}
    </div>}
  </div>;
}
