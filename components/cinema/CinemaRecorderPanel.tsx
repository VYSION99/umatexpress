"use client";

import { useState } from "react";
import { Circle, Download, Pause, Play, Trash2 } from "lucide-react";
import type { CinemaMedia } from "./useCinemaMedia";
import type { CinemaRecorder } from "./useCinemaRecorder";

/** 320 seconds reads as 05:20; an hour-long take keeps its hours. */
function clockTime(seconds: number) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${pad(minutes)}:${pad(remainder)}`;
}

/**
 * The private recorder, as its own card opened from the recorder button.
 *
 * It records this member's own microphone and camera — never the room's video
 * and never a peer's track — with everyone in the room told that a take is
 * running. The MediaRecorder itself lives in the room, not here, so closing
 * this card mid-take pauses the picture rather than the recording; the card
 * only draws the state the room owns.
 */
export function CinemaRecorderPanel({ media, recorder, connected }: { media: CinemaMedia; recorder: CinemaRecorder; connected: boolean }) {
  const [consent, setConsent] = useState(false);
  const running = recorder.phase === "recording" || recorder.phase === "paused";

  const startRecording = () => {
    if (consent) recorder.start();
  };

  return <section className="cinema-card cinema-recorder-panel">
    <div className="cinema-presence-head">
      <h2>Recorder</h2>
      <span className={`cinema-link${running ? " is-live" : ""}`}>
        {running
          ? <><Circle size={10} aria-hidden /> {clockTime(recorder.elapsedSeconds)}</>
          : phaseCopy(recorder.phase)}
      </span>
    </div>

    {!media.policy.recordings
      ? <p className="cinema-note">Recordings are switched off on this deployment. An existing take is still yours to download.</p>
      : <>
        <p className="cinema-note">
          Records your own microphone{media.cameraOn ? " and camera" : ""} — never the room&apos;s video. Everyone here sees a recording is running,
          and every take is deleted with the room.
        </p>
        <label className="cinema-upload-consent">
          <input type="checkbox" checked={consent} disabled={running} onChange={(event) => setConsent(event.target.checked)} />
          I have everyone&apos;s consent to record this study session.
        </label>
        <div className="cinema-controls cinema-sub">
          {running
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
                disabled={!connected || !consent || (!media.micOn && !media.cameraOn) || recorder.phase === "uploading"}
                onClick={startRecording}
              >
                <Circle size={13} aria-hidden /> {recorder.phase === "uploading" ? "Saving…" : "Start recording"}
              </button>
              {(recorder.phase === "ready" || recorder.phase === "error") && <button type="button" className="secondary" onClick={recorder.reset}>Record another</button>}
            </>}
        </div>
        {!media.micOn && !media.cameraOn && recorder.phase !== "uploading" && <p className="cinema-note cinema-sub">
          Turn on your mic or camera from the call buttons first; there is nothing to record yet.
        </p>}
        {!connected && <p className="cinema-note cinema-sub">
          The room is reconnecting. A take can start the moment it is live again.
        </p>}
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
  </section>;
}

/** The one-line state the card shows when no take is running. */
function phaseCopy(phase: CinemaRecorder["phase"]) {
  if (phase === "uploading") return "Saving…";
  if (phase === "ready") return "Saved to your takes";
  if (phase === "error") return "Something went wrong";
  return "Not recording";
}
