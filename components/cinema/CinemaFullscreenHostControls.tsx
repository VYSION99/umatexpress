"use client";

import { useState } from "react";
import { Camera, CameraSlash, Microphone, MicrophoneSlash, Pause, Play, SquaresFour, UserPlus, X } from "@/components/ui/MaterialIcon";
import type { CinemaPlaybackAction, CinemaPlaybackState } from "@/lib/cinema-engine/protocol";
import { expectedPosition } from "@/lib/cinema-engine/sync";
import type { CinemaMedia } from "./useCinemaMedia";
import { CinemaStageRequestsPanel } from "./CinemaStageRequestsPanel";

export type CinemaHostControlsContext = {
  media: CinemaMedia;
  playback: CinemaPlaybackState | null;
  now: () => number;
  onAction: (action: CinemaPlaybackAction) => void;
  roomId: string;
  waitingEnabled: boolean;
  waiting: Array<{ studentId: string; displayName: string }>;
  stageLimit: number;
  discussionMode: boolean;
  stageRequestCount: number;
  onWaitingDecision: (studentId: string, action: "ADMIT" | "REJECT") => void;
};

/** Mounted inside the fullscreen element, so host controls remain operable there. */
export function CinemaFullscreenHostControls({ host }: { host?: CinemaHostControlsContext }) {
  const [open, setOpen] = useState(false);
  if (!host) return null;
  const waitingCount = host.waitingEnabled ? host.waiting.length : 0;
  const requests = waitingCount + host.stageRequestCount;
  const playbackAction = () => {
    if (!host.playback) return;
    host.onAction({
      type: host.playback.isPlaying ? "pause" : "play",
      time: expectedPosition(host.playback, host.now()),
      duration: host.playback.durationSeconds || undefined,
      stateAt: host.playback.updatedAt,
    });
  };
  return <>
    {requests > 0 && <button type="button" className="cinema-fullscreen-host-alert" onClick={() => setOpen(true)} aria-label={`${requests} pending host ${requests === 1 ? "request" : "requests"}. Open requests.`}><UserPlus size={16} aria-hidden /> {requests} {requests === 1 ? "request" : "requests"}</button>}
    <div className={`cinema-fullscreen-host${open ? " is-open" : ""}`}>
    <div className="cinema-fullscreen-host-rail" role="toolbar" aria-label="Fullscreen host controls">
      <button type="button" disabled={!host.playback} onClick={playbackAction} aria-label={host.playback?.isPlaying ? "Pause room video" : "Play room video"}>{host.playback?.isPlaying ? <Pause size={19} aria-hidden /> : <Play size={19} aria-hidden />}<span>{host.playback?.isPlaying ? "Pause" : "Play"}</span></button>
      <button type="button" disabled={!host.media.policy.voice} onClick={() => void host.media.toggleMic()} aria-label={host.media.micOn ? "Mute my microphone" : "Unmute my microphone"}>{host.media.micOn ? <Microphone size={19} aria-hidden /> : <MicrophoneSlash size={19} aria-hidden />}<span>Mic {host.media.micOn ? "on" : "off"}</span></button>
      <button type="button" className="cinema-fullscreen-host-camera" disabled={!host.media.policy.camera} onClick={() => void host.media.toggleCamera()} aria-label={host.media.cameraOn ? "Turn my camera off" : "Turn my camera on"}>{host.media.cameraOn ? <Camera size={19} aria-hidden /> : <CameraSlash size={19} aria-hidden />}<span>Camera {host.media.cameraOn ? "on" : "off"}</span></button>
      <button type="button" className={`cinema-fullscreen-host-requests${requests ? " has-requests" : ""}`} aria-expanded={open} aria-controls="cinema-fullscreen-host-panel" onClick={() => setOpen(value => !value)}><UserPlus size={19} aria-hidden /><span>Requests{requests ? ` (${requests})` : ""}</span></button>
      <button type="button" className={`cinema-fullscreen-host-more${requests ? " has-requests" : ""}`} aria-label={`More host controls${requests ? `, ${requests} pending requests` : ""}`} aria-expanded={open} aria-controls="cinema-fullscreen-host-panel" onClick={() => setOpen(value => !value)}><SquaresFour size={19} aria-hidden /><span>More{requests ? ` (${requests})` : ""}</span></button>
    </div>
    {open && <section id="cinema-fullscreen-host-panel" className="cinema-fullscreen-host-panel" aria-label="Host controls">
      <header><strong>Host controls</strong><button type="button" aria-label="Close host controls" onClick={() => setOpen(false)}><X size={17} aria-hidden /></button></header>
      <div className="cinema-fullscreen-host-mobile-action"><button type="button" disabled={!host.media.policy.camera} onClick={() => void host.media.toggleCamera()}>{host.media.cameraOn ? <Camera size={18} aria-hidden /> : <CameraSlash size={18} aria-hidden />} {host.media.cameraOn ? "Turn camera off" : "Turn camera on"}</button></div>
      {host.waitingEnabled && <div className="cinema-fullscreen-host-waiting"><h3>Waiting room <span>{waitingCount}</span></h3>{waitingCount ? host.waiting.map(member => <div key={member.studentId}><strong>{member.displayName}</strong><span><button type="button" onClick={() => host.onWaitingDecision(member.studentId, "ADMIT")}>Admit</button><button type="button" onClick={() => host.onWaitingDecision(member.studentId, "REJECT")}>Decline</button></span></div>) : <p>Nobody is waiting.</p>}</div>}
      {host.discussionMode && <CinemaStageRequestsPanel roomId={host.roomId} stageLimit={host.stageLimit} />}
      {!host.waitingEnabled && !host.discussionMode && <p>No requests to manage in this room.</p>}
    </section>}
    </div>
  </>;
}
