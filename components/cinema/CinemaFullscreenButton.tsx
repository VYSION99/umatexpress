"use client";

import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { FullscreenExit } from "@/components/ui/MaterialIcon";

export type CinemaFullscreenState = { active: boolean; fallback: boolean };

export function CinemaFullscreenButton({ playerRef, state, onChange }: {
  playerRef: RefObject<HTMLDivElement | null>;
  state: CinemaFullscreenState;
  onChange: Dispatch<SetStateAction<CinemaFullscreenState>>;
}) {
  const requestingRef = useRef(false);
  const sync = useCallback(() => {
    onChange({ active: document.fullscreenElement === playerRef.current, fallback: false });
  }, [onChange, playerRef]);

  useEffect(() => {
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [sync]);

  // Native video fullscreen hides the camera layer on some phones. Keep the
  // whole player in view as an in-page fullscreen fallback instead.
  useEffect(() => {
    if (!state.fallback) return;
    document.body.classList.add("cinema-fullscreen-open");
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onChange({ active: false, fallback: false });
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.classList.remove("cinema-fullscreen-open");
      document.removeEventListener("keydown", escape);
    };
  }, [onChange, state.fallback]);

  const toggle = async () => {
    if (requestingRef.current) return;
    if (state.fallback) {
      onChange({ active: false, fallback: false });
    } else if (document.fullscreenElement === playerRef.current) {
      await document.exitFullscreen().catch(() => undefined);
    } else {
      const player = playerRef.current;
      const theater = () => onChange({ active: true, fallback: true });
      if (!player?.requestFullscreen || document.fullscreenEnabled === false) {
        theater();
        return;
      }
      requestingRef.current = true;
      try {
        // Some iPhone browsers expose the method but never make a div full
        // screen. Bound the wait and verify the result rather than trusting
        // a resolved (or permanently pending) promise.
        await Promise.race([
          player.requestFullscreen(),
          new Promise<void>((resolve) => window.setTimeout(resolve, 700)),
        ]);
        if (document.fullscreenElement !== player) theater();
        else onChange({ active: true, fallback: false });
      } catch {
        theater();
      } finally {
        requestingRef.current = false;
      }
    }
  };

  return <button type="button" className="cinema-fullscreen-button" onClick={() => void toggle()} aria-label={state.active ? "Exit Cinema full screen" : "Cinema full screen"} title={state.active ? "Exit Cinema full screen" : "Cinema full screen"}>
    {state.active ? <FullscreenExit size={23} aria-hidden /> : <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 2H4a2 2 0 0 0-2 2v5M15 2h5a2 2 0 0 1 2 2v5M2 15v5a2 2 0 0 0 2 2h5M22 15v5a2 2 0 0 1-2 2h-5" />
    </svg>}
  </button>;
}
