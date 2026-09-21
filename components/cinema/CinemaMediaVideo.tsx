"use client";

import { useCallback } from "react";

/**
 * One live stream, attached to a video element.
 *
 * It is the only piece of the old Voice & video panel that the room still
 * needs as a component: the strip draws every camera with it, including the
 * audio-only peers that need an element to play through.
 */
export function MediaStreamVideo({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const attach = useCallback((element: HTMLVideoElement | null) => {
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);
  return <video ref={attach} className={className} autoPlay playsInline muted={muted} />;
}
