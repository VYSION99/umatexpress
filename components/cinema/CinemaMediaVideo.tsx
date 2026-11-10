"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PictureInPicture } from "@/components/ui/MaterialIcon";

/**
 * One live stream, attached to a video element.
 *
 * It is the only piece of the old Voice & video panel that the room still
 * needs as a component: the strip draws every camera with it, including the
 * audio-only peers that need an element to play through.
 */
export function MediaStreamVideo({ stream, muted, className, pictureInPicture = false, audioOnly = false }: { stream: MediaStream | null; muted?: boolean; className?: string; pictureInPicture?: boolean; audioOnly?: boolean }) {
  const videoRef = useRef<HTMLMediaElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  const play = useCallback(() => {
    const node = videoRef.current;
    if (!node || muted) return;
    void node.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  }, [muted]);
  useEffect(() => {
    // Retry after an interaction when the browser initially blocks sound.
    document.addEventListener("pointerdown", play);
    document.addEventListener("keydown", play);
    return () => {
      document.removeEventListener("pointerdown", play);
      document.removeEventListener("keydown", play);
    };
  }, [play]);
  const attach = useCallback((element: HTMLMediaElement | null) => {
    videoRef.current = element;
    if (element && element.srcObject !== stream) element.srcObject = stream;
    if (element && stream) play();
  }, [stream, play]);
  if (audioOnly) return <>
    <audio ref={attach} autoPlay onLoadedMetadata={play} />
    {blocked && <button type="button" onClick={play}>Enable room audio</button>}
  </>;
  const video = <video ref={attach} className={className} autoPlay playsInline muted={muted} />;
  if (!pictureInPicture) return video;
  const pipAvailable = typeof document !== "undefined" && document.pictureInPictureEnabled;
  return <div className="cinema-presentation-video">{video}{pipAvailable && <button type="button" aria-label="Open presentation in picture in picture" onClick={() => { const node = videoRef.current as HTMLVideoElement | null; if (!node || !("requestPictureInPicture" in node)) return; if (document.pictureInPictureElement) void document.exitPictureInPicture(); else void node.requestPictureInPicture().catch(() => undefined); }}><PictureInPicture size={16} /> Picture in picture</button>}</div>;
}
