"use client";

import { useCallback, useState } from "react";
import { Camera, CameraOff, Circle, Download, Mic, MicOff, Pause, Play, Trash2 } from "lucide-react";
import type { CinemaClientMessage } from "@/lib/cinema-engine/protocol";
import type { CinemaMedia } from "./useCinemaMedia";
import { useCinemaRecorder } from "./useCinemaRecorder";

/**
 * The room's voice, video and recorder.
 *
 * The panel is honest about what a room can do: it shows the deployment's
 * switches, says when only STUN is available, marks who is talking, and tells
 * the room when a recording starts. A member who does not want to appear simply
 * never presses a button — nothing here opens a device on mount.
 *
 * The call itself is owned one level up, in the room, because the member's own
 * camera renders in the strip under the video rather than inside this panel.
 * What stays here is the shape of the call: the switches, what this deployment
 * allows, and the recorder, which records the local microphone and camera only.
 */

export function MediaStreamVideo({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const attach = useCallback((element: HTMLVideoElement | null) => {
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);
  return <video ref={attach} className={className} autoPlay playsInline muted={muted} />;
}

function clockTime(seconds: number) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${pad(minutes)}:${pad(remainder)}`;
}

export function CinemaMediaPanel(input: {
  roomId: string;
  enabled: boolean;
  send: (message: CinemaClientMessage) => void;
  media: CinemaMedia;
}) {
  const { roomId, enabled, send, media } = input;
  const [consent, setConsent] = useState(false);

  const recorder = useCinemaRecorder({
    roomId,
    enabled: enabled && media.policy.recordings,
    maxMinutes: media.policy.maxRecordingMinutes,
    stream: media.localStream,
    send,
  });

  const anyPolicy = media.policy.voice || media.policy.camera;

  const startRecording = () => {
    if (!consent) return;
    recorder.start();
  };

  return <section className="cinema-card cinema-media">
    <div className="cinema-presence-head">
      <h2>Voice &amp; video</h2>
      <span className={`cinema-link ${media.policy.turn ? "is-live" : ""}`}>
        {media.policy.turn ? "Relay ready" : "Direct only"}
      </span>
    </div>
    {!media.policyLoaded
      ? <p className="cinema-note">Checking what this room may use…</p>
      : !anyPolicy
        ? <p className="cinema-note">Voice and camera are switched off on this deployment. Chat and the video still work.</p>
        : <>
          <div className="cinema-media-controls">
            <button
              type="button"
              className={`cinema-media-toggle ${media.micOn ? "is-on" : ""}`}
              disabled={!media.policy.voice}
              aria-pressed={media.micOn}
              onClick={() => void media.toggleMic()}
            >
              {media.micOn ? <Mic size={15} aria-hidden /> : <MicOff size={15} aria-hidden />}
              {media.micOn ? "Mic on" : "Mic off"}
            </button>
            <button
              type="button"
              className={`cinema-media-toggle ${media.cameraOn ? "is-on" : ""}`}
              disabled={!media.policy.camera}
              aria-pressed={media.cameraOn}
              onClick={() => void media.toggleCamera()}
            >
              {media.cameraOn ? <Camera size={15} aria-hidden /> : <CameraOff size={15} aria-hidden />}
              {media.cameraOn ? "Camera on" : "Camera off"}
            </button>
          </div>
          <p className="cinema-note cinema-sub">
            {media.policy.turn
              ? "Audio and video travel between members. The TURN relay is used only when two networks cannot connect directly."
              : "No relay is configured, so this room connects directly. On campus Wi-Fi that works; some mobile networks may not."}
          </p>
          {media.error && <p className="cinema-error cinema-sub">{media.error}</p>}
          <p className="cinema-note cinema-sub">
            The cameras are in the strip under the video; this panel is where they are switched.
          </p>

          {(media.policy.recordings || recorder.recordings.length > 0) && <div className="cinema-recorder">
            <h3>Take notes</h3>
            {!media.policy.recordings
              ? <p className="cinema-note">Recordings are switched off on this deployment. An existing take is still yours to download.</p>
              : <>
                <p className="cinema-note">
                  Records your own microphone{media.cameraOn ? " and camera" : ""} — never the room&apos;s video. Everyone here sees a recording is running.
                </p>
                <label className="cinema-upload-consent">
                  <input type="checkbox" checked={consent} disabled={recorder.phase === "recording" || recorder.phase === "paused"} onChange={(event) => setConsent(event.target.checked)} />
                  I have everyone&apos;s consent to record this study session.
                </label>
                <div className="cinema-controls cinema-sub">
                  {recorder.phase === "recording" || recorder.phase === "paused"
                    ? <>
                      <span className="cinema-chip is-live"><Circle size={10} aria-hidden /> {clockTime(recorder.elapsedSeconds)}</span>
                      <button type="button" className="secondary" onClick={recorder.pauseOrResume}>
                        {recorder.phase === "paused" ? <><Play size={14} aria-hidden /> Resume</> : <><Pause size={14} aria-hidden /> Pause</>}
                      </button>
                      <button type="button" className="danger" onClick={recorder.stop}>Stop and save</button>
                    </>
                    : <>
                      <button
                        type="button"
                        disabled={!consent || (!media.micOn && !media.cameraOn) || recorder.phase === "uploading"}
                        onClick={startRecording}
                      >
                        <Circle size={13} aria-hidden /> {recorder.phase === "uploading" ? "Saving…" : "Start recording"}
                      </button>
                      {(recorder.phase === "ready" || recorder.phase === "error") && <button type="button" className="secondary" onClick={recorder.reset}>Record another</button>}
                    </>}
                </div>
                {!media.micOn && !media.cameraOn && recorder.phase !== "uploading" && <p className="cinema-note cinema-sub">Turn on your mic or camera first; there is nothing to record yet.</p>}
              </>}
            {recorder.progress && <div className="cinema-upload-progress">
              <div className="cinema-upload-bar" style={{ width: `${Math.round((recorder.progress.sent / Math.max(1, recorder.progress.total)) * 100)}%` }} />
              <span>{Math.round((recorder.progress.sent / Math.max(1, recorder.progress.total)) * 100)}% — part {recorder.progress.sent} of {recorder.progress.total}</span>
            </div>}
            {recorder.error && <p className="cinema-error cinema-sub">{recorder.error}</p>}
            {recorder.recordings.length > 0 && <ul className="cinema-recording-list">
              {recorder.recordings.map((recording) => <li key={recording.id}>
                <span>
                  <strong>{recording.mimeType.startsWith("video") ? "Voice + camera" : "Voice"}</strong>
                  <small>{clockTime(recording.durationSeconds)} · {Math.max(1, Math.round(recording.sizeBytes / (1024 * 1024)))} MB</small>
                </span>
                <a className="cinema-record-download" href={`/api/cinema/recordings/${recording.id}/file`} download>
                  <Download size={13} aria-hidden /> Download
                </a>
                <button type="button" className="cinema-record-delete" aria-label="Delete this recording" onClick={() => void recorder.discard(recording.id)}>
                  <Trash2 size={13} aria-hidden />
                </button>
              </li>)}
            </ul>}
          </div>}
        </>}
  </section>;
}
