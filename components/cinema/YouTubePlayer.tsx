"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaClientMessage, CinemaPlaybackAction, CinemaPlaybackState } from "@/lib/cinema-engine/protocol";
import { CINEMA_DRIFT_THRESHOLD_SECONDS, CINEMA_HOST_DRIFT_SECONDS, expectedPosition, reconcilePlayback } from "@/lib/cinema-engine/sync";

/**
 * The official YouTube player, driven by the room.
 *
 * This component is the only place a third-party script runs, the same way the
 * map is the only place MapLibre runs: one owner, one iframe, one load. It
 * never talks to the socket directly — it reports the host's intent upward and
 * applies the state that comes back down, which keeps "what the room says" and
 * "what the player shows" from becoming two different stories.
 *
 * Members cannot pause or seek the room from their own player: a local
 * interaction is detected and undone a moment later. That is a courtesy, not
 * the guard — the Durable Object drops a non-host's action regardless.
 */

// YouTube's documented PlayerState values, stable since forever.
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

type YouTubePlayerInstance = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
};

type YouTubeNamespace = {
  Player: new (element: HTMLElement, options: Record<string, unknown>) => YouTubePlayerInstance;
};

/** The API is fetched once per page, not once per room. */
let apiPromise: Promise<void> | null = null;

function youTubeNamespace() {
  return (window as unknown as { YT?: YouTubeNamespace }).YT;
}

function loadYouTubeApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    if (youTubeNamespace()?.Player) { resolve(); return; }
    const callbacks = window as unknown as { onYouTubeIframeAPIReady?: () => void; YT?: YouTubeNamespace };
    const previous = callbacks.onYouTubeIframeAPIReady;
    const timer = window.setTimeout(() => { apiPromise = null; reject(new Error("The YouTube player did not load.")); }, 15_000);
    callbacks.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      apiPromise = null;
      reject(new Error("The YouTube player could not be fetched."));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

function numberOr(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function YouTubePlayer(input: {
  videoId: string;
  isHost: boolean;
  playback: CinemaPlaybackState | null;
  onAction: (message: CinemaClientMessage) => void;
}) {
  const { videoId } = input;
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [needsTap, setNeedsTap] = useState(false);

  // Props are mirrored into refs so the iframe is created once per video: a
  // re-created player would lose its position and its event handlers. The
  // mirror is written in an effect (never during render) and is declared
  // before the effects that read it, so a commit never sees yesterday's props.
  const playbackRef = useRef(input.playback);
  const isHostRef = useRef(input.isHost);
  const onActionRef = useRef(input.onAction);
  useEffect(() => {
    playbackRef.current = input.playback;
    isHostRef.current = input.isHost;
    onActionRef.current = input.onAction;
  });
  const readyRef = useRef(false);
  // A programmatic seek/play is not the student's doing, so the events it fires
  // are ignored for a moment instead of being echoed back as their intent.
  const applyingUntilRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendNow = useCallback((action: CinemaPlaybackAction) => {
    onActionRef.current(action);
  }, []);

  /**
   * The host's player actions are debounced by a moment: dragging the scrubber
   * fires pause-then-play, and broadcasting only the play keeps members from
   * blinking through a pause the host never meant to keep.
   */
  const queueAction = useCallback((action: CinemaPlaybackAction) => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      sendNow(action);
    }, 300);
  }, [sendNow]);

  /** Brings the player to the room's state, within the drift threshold. */
  const apply = useCallback((options: { force?: boolean } = {}) => {
    const player = playerRef.current;
    const state = playbackRef.current;
    if (!player || !state || !readyRef.current) return;
    const now = Date.now();
    const playerStatus = numberOr(player.getPlayerState(), -1);
    const intent = reconcilePlayback({
      playback: state,
      playerTime: numberOr(player.getCurrentTime()),
      playerPlaying: playerStatus === PLAYING,
      playerReady: true,
      now,
      buffering: playerStatus === BUFFERING && !options.force,
      threshold: CINEMA_DRIFT_THRESHOLD_SECONDS,
    });
    if (intent.seekTo === undefined && intent.resume === undefined) return;

    applyingUntilRef.current = now + 900;
    if (intent.seekTo !== undefined) player.seekTo(intent.seekTo, true);
    if (intent.resume === true) player.playVideo();
    if (intent.resume === false) player.pauseVideo();

    // A browser without a gesture behind it refuses to start playback. The
    // room then offers the student a button, which is a gesture.
    if (intent.resume === true) {
      window.setTimeout(() => {
        const current = playerRef.current;
        if (!current) return;
        const currentStatus = numberOr(current.getPlayerState(), -1);
        if (currentStatus !== PLAYING && currentStatus !== BUFFERING) setNeedsTap(true);
      }, 1_800);
    }
  }, []);

  const handleStateChange = useCallback((data: number) => {
    const player = playerRef.current;
    if (!player) return;
    // Our own seek/play/pause, not the student's.
    if (Date.now() < applyingUntilRef.current) return;

    if (isHostRef.current) {
      const time = numberOr(player.getCurrentTime());
      const base = { time, duration: numberOr(player.getDuration()), stateAt: playbackRef.current?.updatedAt };
      if (data === PLAYING) queueAction({ type: "play", ...base });
      else if (data === PAUSED) queueAction({ type: "pause", time, stateAt: base.stateAt });
      else if (data === ENDED) queueAction({ type: "pause", time: base.duration || time, stateAt: base.stateAt });
      return;
    }

    // A member's own pause or play is undone in a moment.
    if (data === PLAYING || data === PAUSED) {
      window.setTimeout(() => apply({ force: true }), 350);
    }
  }, [apply, queueAction]);

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) return;

    void loadYouTubeApi().then(() => {
      if (disposed || !containerRef.current) return;
      const namespace = youTubeNamespace();
      if (!namespace?.Player) { setStatus("failed"); return; }
      // The API replaces the element it is given, so it gets a child of the
      // container rather than the container itself: the effect's cleanup then
      // always has a stable element to rebuild inside.
      const mount = document.createElement("div");
      containerRef.current.replaceChildren(mount);
      playerRef.current = new namespace.Player(mount, {
        videoId,
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          rel: 0,
          playsinline: 1,
          modestbranding: 1,
          controls: isHostRef.current ? 1 : 0,
          disablekb: isHostRef.current ? 0 : 1,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            setStatus("ready");
            // The refresh-mid-playback path: the room's state was already in
            // hand before the player existed, so the first frame is correct.
            apply({ force: true });
          },
          onError: () => setStatus("failed"),
          onStateChange: (event: { data?: number }) => handleStateChange(numberOr(event?.data, -1)),
        },
      });
    }).catch(() => setStatus("failed"));

    return () => {
      disposed = true;
      readyRef.current = false;
      if (pendingRef.current) clearTimeout(pendingRef.current);
      pendingRef.current = null;
      try {
        playerRef.current?.destroy();
      } catch { /* an iframe already gone is not a cleanup failure */ }
      playerRef.current = null;
    };
  }, [videoId, apply, handleStateChange]);

  // A new authoritative state is applied as soon as it arrives.
  useEffect(() => {
    if (status === "ready") apply();
  }, [status, input.playback, apply]);

  // The steady state: members correct toward the room, the host reports a
  // player that has fallen behind the room (a stall, or a scrub it survived).
  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      const state = playbackRef.current;
      if (!player || !state || Date.now() < applyingUntilRef.current) return;
      const playerStatus = numberOr(player.getPlayerState(), -1);
      if (playerStatus === BUFFERING) return;
      if (!isHostRef.current) { apply(); return; }
      const drift = numberOr(player.getCurrentTime()) - expectedPosition(state, Date.now());
      if (Math.abs(drift) > CINEMA_HOST_DRIFT_SECONDS) {
        sendNow({ type: "seek", time: numberOr(player.getCurrentTime()), duration: numberOr(player.getDuration()) || undefined, stateAt: state.updatedAt });
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [status, apply, sendNow]);

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  return <div className="cinema-player">
    <div className="cinema-player-frame" ref={containerRef} aria-label="The room's video" />
    {status === "loading" && <p className="cinema-player-note">Loading the player…</p>}
    {status === "failed" && <p className="cinema-player-note">
      The player could not load here. <a href={watchUrl} target="_blank" rel="noreferrer">Open the video on YouTube</a> — the room&apos;s controls still work.
    </p>}
    {needsTap && <div className="cinema-player-veil">
      <button onClick={() => { setNeedsTap(false); apply({ force: true }); playerRef.current?.playVideo(); }}>
        Tap to join playback
      </button>
      <span>Your browser paused the video until you interacted with the page.</span>
    </div>}
  </div>;
}
