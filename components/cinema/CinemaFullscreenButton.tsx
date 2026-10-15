"use client";

import { useEffect, useState, type RefObject } from "react";
import { Fullscreen, FullscreenExit } from "@/components/ui/MaterialIcon";

export function CinemaFullscreenButton({ playerRef, videoRef }: {
  playerRef: RefObject<HTMLDivElement | null>;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setExpanded(document.fullscreenElement === playerRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [playerRef]);

  const toggle = async () => {
    setError("");
    try {
      if (document.fullscreenElement === playerRef.current) {
        await document.exitFullscreen();
      } else {
        try {
          if (!playerRef.current?.requestFullscreen) throw new Error("Element fullscreen is unavailable.");
          await playerRef.current.requestFullscreen();
        } catch {
          const nativeVideo = videoRef?.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined;
          if (!nativeVideo?.webkitEnterFullscreen) throw new Error("Fullscreen is unavailable in this browser.");
          nativeVideo.webkitEnterFullscreen();
        }
      }
    } catch {
      setError("Fullscreen is unavailable in this browser.");
    }
  };

  return <>
    <button type="button" className="cinema-fullscreen-button" onClick={() => void toggle()} aria-label={expanded ? "Exit full screen" : "Watch full screen"}>
      {expanded ? <FullscreenExit size={19} aria-hidden /> : <Fullscreen size={19} aria-hidden />}
      <span>{expanded ? "Exit full screen" : "Full screen"}</span>
    </button>
    {error && <span className="cinema-fullscreen-error" role="status">{error}</span>}
  </>;
}
