"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaClientMessage, CinemaPlaybackAction, CinemaPlaybackState } from "@/lib/cinema-engine/protocol";
import { CINEMA_DRIFT_THRESHOLD_SECONDS, CINEMA_HOST_DRIFT_SECONDS, expectedPosition, reconcilePlayback } from "@/lib/cinema-engine/sync";

/**
 * The room's uploaded video, driven by the room.
 *
 * The twin of the YouTube player, against an HTML5 element: the room's state is
 * the only thing that moves it, the host's own play/pause/seek travel upward,
 * and a member's local action is undone a moment later. The URL is a lease,
 * not a link — when the object refuses a range because the lease ran out, this
 * asks for a fresh one and picks the video back up where it was.
 */

export function UploadPlayer(input: {
  roomId: string;
  isHost: boolean;
  playback: CinemaPlaybackState | null;
  onAction: (message: CinemaClientMessage) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [needsTap, setNeedsTap] = useState(false);
  const [lease, setLease] = useState("");
  const reloadsRef = useRef(0);

  // Props are mirrored into refs for the same reason the YouTube player does
  // it: the element is created once per lease, and an effect that read a stale
  // prop would drive playback with yesterday's room state.
  const playbackRef = useRef(input.playback);
  const isHostRef = useRef(input.isHost);
  const onActionRef = useRef(input.onAction);
  useEffect(() => {
    playbackRef.current = input.playback;
    isHostRef.current = input.isHost;
    onActionRef.current = input.onAction;
  });
  const readyRef = useRef(false);
  const applyingUntilRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where to land after a lease is replaced mid-playback. */
  const pendingSeekRef = useRef(0);

  const sendNow = useCallback((action: CinemaPlaybackAction) => {
    onActionRef.current(action);
  }, []);

  /** Dragging the scrubber fires pause-then-play; only the play is broadcast. */
  const queueAction = useCallback((action: CinemaPlaybackAction) => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      sendNow(action);
    }, 300);
  }, [sendNow]);

  const apply = useCallback((options: { force?: boolean } = {}) => {
    const video = videoRef.current;
    const state = playbackRef.current;
    if (!video || !state || !readyRef.current) return;
    const now = Date.now();
    const intent = reconcilePlayback({
      playback: state,
      playerTime: Number(video.currentTime || 0),
      playerPlaying: !video.paused && !video.ended,
      playerReady: readyRef.current,
      now,
      buffering: video.readyState < 3 && !options.force,
      threshold: CINEMA_DRIFT_THRESHOLD_SECONDS,
    });
    if (intent.seekTo === undefined && intent.resume === undefined) return;
    applyingUntilRef.current = now + 900;
    if (intent.seekTo !== undefined) video.currentTime = intent.seekTo;
    if (intent.resume === true) {
      const started = video.play();
      if (started) started.catch(() => setNeedsTap(true));
    }
    if (intent.resume === false) video.pause();
  }, []);

  /** A fresh lease, as data; the callers below decide what to do with it. */
  const requestLease = useCallback(async () => {
    try {
      const response = await fetch(`/api/cinema/sessions/${input.roomId}/video-url`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { url?: string; error?: string };
      return { ok: response.ok, url: String(data.url || ""), error: String(data.error || "") };
    } catch {
      return { ok: false, url: "", error: "The room could not be reached." };
    }
  }, [input.roomId]);

  const acceptLease = useCallback((lease: { ok: boolean; url: string }, at: number) => {
    if (!lease.ok || !lease.url) { setStatus("failed"); return; }
    readyRef.current = false;
    setStatus("loading");
    setLease(lease.url);
    // The position is restored once the new media reports its metadata.
    pendingSeekRef.current = at;
  }, []);

  // The first lease. The setState calls live in the callbacks, which is what
  // keeps this an external subscription rather than a render-time cascade.
  useEffect(() => {
    let disposed = false;
    void requestLease().then((lease) => { if (!disposed) acceptLease(lease, 0); });
    return () => { disposed = true; };
  }, [requestLease, acceptLease]);

  const handlePlayPause = useCallback((kind: "play" | "pause") => {
    if (Date.now() < applyingUntilRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const time = Number(video.currentTime || 0);
    if (isHostRef.current) {
      queueAction({ type: kind, time, ...(duration ? { duration } : {}), stateAt: playbackRef.current?.updatedAt });
      return;
    }
    window.setTimeout(() => apply({ force: true }), 350);
  }, [apply, queueAction]);

  // A new authoritative state is applied as soon as it arrives.
  useEffect(() => {
    if (status === "ready") apply();
  }, [status, input.playback, apply]);

  // The steady state: members correct toward the room, the host reports a
  // player that has fallen behind it.
  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const state = playbackRef.current;
      if (!video || !state || Date.now() < applyingUntilRef.current) return;
      if (video.readyState < 3) return;
      if (!isHostRef.current) { apply(); return; }
      const drift = Number(video.currentTime || 0) - expectedPosition(state, Date.now());
      if (Math.abs(drift) > CINEMA_HOST_DRIFT_SECONDS) {
        sendNow({ type: "seek", time: Number(video.currentTime || 0), duration: Number.isFinite(video.duration) ? video.duration : undefined, stateAt: state.updatedAt });
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [status, apply, sendNow]);

  return <div className="cinema-player">
    <video
      ref={videoRef}
      className={`cinema-upload-video${input.isHost ? "" : " is-passive"}`}
      src={lease || undefined}
      controls={input.isHost}
      playsInline
      preload="metadata"
      aria-label="The room's video"
      onLoadedMetadata={() => {
        const video = videoRef.current;
        if (video && pendingSeekRef.current > 0) video.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = 0;
        readyRef.current = true;
        reloadsRef.current = 0;
        setStatus("ready");
        apply({ force: true });
      }}
      onPlay={() => handlePlayPause("play")}
      onPause={() => handlePlayPause("pause")}
      onError={() => {
        // A lease that ran out mid-playback is replaced once, at the same spot,
        // rather than shown as a broken video.
        if (reloadsRef.current < 2) {
          reloadsRef.current += 1;
          const at = Number(videoRef.current?.currentTime || 0);
          void requestLease().then((lease) => acceptLease(lease, at));
          return;
        }
        setStatus("failed");
      }}
    />
    {status === "loading" && <p className="cinema-player-note">Loading the room&apos;s video…</p>}
    {status === "failed" && <p className="cinema-player-note">
      The video could not play here. Ask the host to check the upload, or try again in a moment.
    </p>}
    {needsTap && <div className="cinema-player-veil">
      <button onClick={() => { setNeedsTap(false); apply({ force: true }); void videoRef.current?.play().catch(() => undefined); }}>
        Tap to join playback
      </button>
      <span>Your browser paused the video until you interacted with the page.</span>
    </div>}
  </div>;
}
