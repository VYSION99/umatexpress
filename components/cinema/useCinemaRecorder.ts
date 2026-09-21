"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaClientMessage } from "@/lib/cinema-engine/protocol";

/**
 * The live recorder.
 *
 * It captures the recorder's own microphone and camera — never the room's
 * playback, and never another member's track on its own — with the browser's
 * MediaRecorder. The bytes are held in memory while the take runs and uploaded
 * through the same private multipart transport as a room's video once it stops.
 * That is a deliberate trade: nothing streams to the server mid-sentence, and a
 * tab that dies mid-take loses that take.
 *
 * The room is told while a recording runs, over the socket, before the first
 * byte is captured. A take is the recorder's own file afterwards: only they can
 * list it, download it, or delete it, and retention deletes it with the room.
 */

export type CinemaRecordingPhase = "idle" | "recording" | "paused" | "uploading" | "ready" | "error";

export type CinemaRecordingView = {
  id: string;
  roomId: string;
  status: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  expiresAt: string;
  createdAt: string;
};

type RecordingLimits = { maxBytes: number; maxMinutes: number; partBytes: number; maxParts: number; types: string[] };

/** The container the browser will actually produce, in preference order. */
export function chooseRecordingMimeType(hasVideo: boolean) {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = hasVideo
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const candidate of candidates) {
    try { if (MediaRecorder.isTypeSupported(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return "";
}

export function useCinemaRecorder(input: {
  roomId: string;
  enabled: boolean;
  maxMinutes: number;
  stream: MediaStream | null;
  send: (message: CinemaClientMessage) => void;
  onReady?: () => void;
}) {
  const { roomId, enabled, maxMinutes, stream, send, onReady } = input;
  const [phase, setPhase] = useState<CinemaRecordingPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [recordings, setRecordings] = useState<CinemaRecordingView[]>([]);
  const [limits, setLimits] = useState<RecordingLimits | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const elapsedRef = useRef(0);
  const disposedRef = useRef(false);
  const stopReasonRef = useRef<"manual" | "unmount" | "limit">("manual");
  const streamRef = useRef<MediaStream | null>(null);
  const sendRef = useRef(send);
  const maxSecondsRef = useRef(Math.max(1, Math.floor(maxMinutes)) * 60);

  useEffect(() => { streamRef.current = stream; }, [stream]);
  useEffect(() => { sendRef.current = send; }, [send]);
  useEffect(() => { elapsedRef.current = elapsedSeconds; }, [elapsedSeconds]);
  useEffect(() => { maxSecondsRef.current = Math.max(1, Math.floor(maxMinutes)) * 60; }, [maxMinutes]);
  useEffect(() => () => { disposedRef.current = true; }, []);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    try {
      const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { recordings?: CinemaRecordingView[]; limits?: RecordingLimits };
      if (!response.ok) return;
      setRecordings(Array.isArray(data.recordings) ? data.recordings : []);
      setLimits(data.limits ?? null);
    } catch { /* the list stays as it was; the recorder still works */ }
  }, [roomId]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings`, { credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { recordings?: CinemaRecordingView[]; limits?: RecordingLimits };
        if (disposed || !response.ok) return;
        setRecordings(Array.isArray(data.recordings) ? data.recordings : []);
        setLimits(data.limits ?? null);
      } catch { /* the panel shows an empty list */ }
    })();
    return () => { disposed = true; };
  }, [enabled, roomId]);

  /** The stopwatch a recording shows, and the one the length limit reads. */
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const tick = () => {
      const now = Date.now();
      const paused = pausedTotalRef.current + (phase === "paused" ? now - pausedAtRef.current : 0);
      const elapsed = Math.max(0, Math.floor((now - startedAtRef.current - paused) / 1000));
      setElapsedSeconds(elapsed);
      // The length limit is enforced here, so a forgotten tab stops itself
      // instead of filling the device's memory and the bucket in one go.
      if (elapsed >= maxSecondsRef.current && recorderRef.current?.state === "recording") {
        stopReasonRef.current = "limit";
        recorderRef.current.stop();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const upload = useCallback(async (mimeType: string) => {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const blob = new Blob(chunks, { type: mimeType });
    sendRef.current({ type: "recording_state", active: false });
    if (disposedRef.current || stopReasonRef.current === "unmount") { setPhase("idle"); return; }
    if (!blob.size) { setError("The recorder produced no audio."); setPhase("error"); return; }
    setPhase("uploading");
    setProgress(null);
    setError("");
    let recordingId = "";
    try {
      const opened = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType, sizeBytes: blob.size, durationSeconds: elapsedRef.current }),
      });
      const opening = await opened.json() as { recording?: CinemaRecordingView; partBytes?: number; parts?: number; error?: string };
      if (!opened.ok || !opening.recording || !opening.partBytes || !opening.parts) throw new Error(opening.error || "The recording could not be started.");
      recordingId = opening.recording.id;
      setProgress({ sent: 0, total: opening.parts });
      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (let index = 0; index < opening.parts; index += 1) {
        const offset = index * opening.partBytes;
        const chunk = blob.slice(offset, Math.min(blob.size, offset + opening.partBytes));
        const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings/${encodeURIComponent(recordingId)}/part?n=${index + 1}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/octet-stream" },
          body: chunk,
        });
        const data = await response.json() as { part?: { partNumber: number; etag: string }; error?: string };
        if (!response.ok || !data.part) throw new Error(data.error || `Part ${index + 1} did not arrive.`);
        parts.push(data.part);
        setProgress({ sent: index + 1, total: opening.parts });
      }
      const finished = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings/${encodeURIComponent(recordingId)}/complete`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      });
      const completion = await finished.json() as { recording?: CinemaRecordingView; error?: string };
      if (!finished.ok || !completion.recording) throw new Error(completion.error || "The recording could not be finished.");
      setPhase("ready");
      setProgress(null);
      onReady?.();
      await refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The recording could not be uploaded.");
      setPhase("error");
      setProgress(null);
      if (recordingId) {
        await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings?recordingId=${encodeURIComponent(recordingId)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      }
    }
  }, [onReady, refresh, roomId]);

  const start = useCallback(() => {
    const activeStream = streamRef.current;
    if (!activeStream || recorderRef.current || !enabled) return;
    const mimeType = chooseRecordingMimeType(activeStream.getVideoTracks().length > 0);
    if (!mimeType) { setError("This browser cannot record audio."); setPhase("error"); return; }
    try {
      const recorder = new MediaRecorder(activeStream, {
        mimeType,
        ...(activeStream.getVideoTracks().length > 0 ? { videoBitsPerSecond: 1_200_000 } : {}),
        audioBitsPerSecond: 96_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        recorderRef.current = null;
        void upload(mimeType);
      };
      stopReasonRef.current = "manual";
      startedAtRef.current = Date.now();
      pausedAtRef.current = 0;
      pausedTotalRef.current = 0;
      elapsedRef.current = 0;
      setElapsedSeconds(0);
      recorder.start(5_000);
      recorderRef.current = recorder;
      setError("");
      setPhase("recording");
      // The room hears about it before the first chunk exists.
      sendRef.current({ type: "recording_state", active: true });
    } catch {
      setError("This browser refused to start the recorder.");
      setPhase("error");
    }
  }, [enabled, upload]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    stopReasonRef.current = "manual";
    recorder.stop();
  }, []);

  const pauseOrResume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      pausedAtRef.current = Date.now();
      recorder.pause();
      setPhase("paused");
    } else if (recorder.state === "paused") {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      recorder.resume();
      setPhase("recording");
    }
  }, []);

  /** The recorder's own hygiene: a take they do not want is deleted now. */
  const discard = useCallback(async (recordingId: string) => {
    try {
      const response = await fetch(`/api/cinema/recordings/${encodeURIComponent(recordingId)}`, { method: "DELETE", credentials: "same-origin" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That recording could not be deleted.");
      setRecordings((current) => current.filter((entry) => entry.id !== recordingId));
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : "That recording could not be deleted.");
    }
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setError("");
    setElapsedSeconds(0);
  }, []);

  return {
    phase,
    elapsedSeconds,
    progress,
    error,
    recordings,
    limits,
    maxSeconds: Math.max(1, Math.floor(maxMinutes)) * 60,
    start,
    stop,
    pauseOrResume,
    discard,
    reset,
    refresh,
  };
}
