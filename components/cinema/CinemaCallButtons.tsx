"use client";

import { Camera, CameraOff, Circle, Mic, MicOff } from "lucide-react";
import type { ReactNode } from "react";
import type { CinemaMedia } from "./useCinemaMedia";
import type { CinemaRecorder } from "./useCinemaRecorder";

/**
 * The call, as three buttons: mic, camera, recorder.
 *
 * These used to be switches inside the Voice & video card, with one rail
 * button opening it. The card is gone and the switches are the buttons: one
 * tap turns the microphone over, one turns the camera over, and one opens the
 * recorder's own card. The buttons render in the room's mobile rail and in the
 * desktop control bar, so neither surface is missing a control the other has;
 * `labels` adds the name under each circle, which is how the bar reads.
 * Nothing here opens a device on its own — a tap does.
 */
export function CinemaCallButtons(input: {
  media: CinemaMedia;
  recorder: CinemaRecorder;
  recordOpen: boolean;
  onToggleRecord: () => void;
  /** Name each button under its icon, for the desktop control bar. */
  labels?: boolean;
}) {
  const { media, recorder } = input;
  const recording = recorder.phase === "recording" || recorder.phase === "paused";
  /** The icon alone in the rail; the icon and its name in the control bar. */
  const face = (label: string, icon: ReactNode) => input.labels
    ? <><span className="cinema-tool-icon">{icon}</span><span className="cinema-tool-label">{label}</span></>
    : icon;

  return <>
    <button
      type="button"
      className={media.micOn ? "is-active" : ""}
      disabled={!media.policy.voice}
      aria-pressed={media.micOn}
      aria-label={media.micOn ? "Turn my microphone off" : "Turn my microphone on"}
      data-tip={media.policy.voice ? (media.micOn ? "Mic on — tap to mute" : "Mic off — tap to talk") : "Voice is switched off on this deployment"}
      onClick={() => void media.toggleMic()}
    >{face("Mic", media.micOn ? <Mic size={18} aria-hidden /> : <MicOff size={18} aria-hidden />)}</button>
    <button
      type="button"
      className={media.cameraOn ? "is-active" : ""}
      disabled={!media.policy.camera}
      aria-pressed={media.cameraOn}
      aria-label={media.cameraOn ? "Turn my camera off" : "Turn my camera on"}
      data-tip={media.policy.camera ? (media.cameraOn ? "Camera on — tap to turn it off" : "Camera off — tap to appear") : "Camera is switched off on this deployment"}
      onClick={() => void media.toggleCamera()}
    >{face("Camera", media.cameraOn ? <Camera size={18} aria-hidden /> : <CameraOff size={18} aria-hidden />)}</button>
    <button
      type="button"
      className={recording ? "is-recording" : input.recordOpen ? "is-active" : ""}
      disabled={!media.policyLoaded}
      aria-expanded={input.recordOpen}
      aria-label="Recorder"
      data-tip="Record my mic and camera"
      onClick={input.onToggleRecord}
    >{face("Record", <Circle size={18} aria-hidden />)}</button>
  </>;
}
