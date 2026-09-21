"use client";

import { Camera, CameraOff, Mic, MicOff } from "lucide-react";
import { MediaStreamVideo } from "./CinemaMediaPanel";
import type { CinemaMedia } from "./useCinemaMedia";

/**
 * Your own camera, as a card of its own.
 *
 * It used to be the first tile inside the Voice & video panel, which meant the
 * one picture a person checks constantly — their own — was behind a sheet on a
 * phone and buried under the room's list on a desktop. The card now sits at
 * the top of the controls: a rounded square beside the action rail on a phone,
 * a small card above the host controls on a desktop. The microphone and camera
 * switches stay in the panel; this is the preview and its two flags.
 */
export function CinemaSelfView({ media }: { media: CinemaMedia }) {
  return <article
    className={`cinema-self-view${media.localLevel > 0 ? " is-speaking" : ""}`}
    aria-label={media.cameraOn ? "Your camera, on" : "Your camera, off"}
  >
    {media.cameraOn
      ? <MediaStreamVideo stream={media.localStream} muted className="cinema-self-video" />
      : <div className="cinema-self-placeholder" aria-hidden><Mic size={16} /><span>You</span></div>}
    <footer>
      <strong>You</strong>
      <span className="cinema-media-flags">
        {media.micOn ? <Mic size={11} aria-label="Microphone on" /> : <MicOff size={11} aria-label="Microphone off" />}
        {media.cameraOn ? <Camera size={11} aria-label="Camera on" /> : <CameraOff size={11} aria-label="Camera off" />}
      </span>
    </footer>
  </article>;
}
