"use client";

import { useCallback, useRef } from "react";
import { PictureInPicture } from "@/components/ui/MaterialIcon";

/**
 * One live stream, attached to a video element.
 *
 * It is the only piece of the old Voice & video panel that the room still
 * needs as a component: the strip draws every camera with it, including the
 * audio-only peers that need an element to play through.
 */
export function MediaStreamVideo({ stream, muted, className, pictureInPicture = false }: { stream: MediaStream | null; muted?: boolean; className?: string; pictureInPicture?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attach = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);
  const video = <video ref={attach} className={className} autoPlay playsInline muted={muted} />;
  if (!pictureInPicture) return video;
  const pipAvailable = typeof document !== "undefined" && document.pictureInPictureEnabled;
  return <div className="cinema-presentation-video">{video}{pipAvailable && <button type="button" aria-label="Open presentation in picture in picture" onClick={() => { const node = videoRef.current; if (!node || !("requestPictureInPicture" in node)) return; if (document.pictureInPictureElement) void document.exitPictureInPicture(); else void node.requestPictureInPicture().catch(() => undefined); }}><PictureInPicture size={16} /> Picture in picture</button>}</div>;
}
