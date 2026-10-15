"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { putCinemaPart } from "./transfer";
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

/** What the hook hands back, so the room can own the take and the panel can draw it. */
export type CinemaRecorder = ReturnType<typeof useCinemaRecorder>;

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

  const [recoveryUrl, setRecoveryUrl] = useState("");
  const recovery = useRef<{ blob: Blob; mime: string; duration: number } | null>(null);
  const urlRef = useRef("");
  const captureRef = useRef<MediaStream | null>(null);
  const byteCount = useRef(0);
  const transferRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
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
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopReasonRef.current = "unmount";
      transferRef.current?.abort();
      if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
      captureRef.current?.getTracks().forEach(track => track.stop());
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled && recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  }, [enabled]);
  useEffect(() => {
    if (!recoveryUrl && phase !== "recording" && phase !== "paused" && phase !== "uploading") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recoveryUrl, phase]);

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

  const upload = useCallback(async () => {
    const saved = recovery.current;
    if (!saved || disposedRef.current || transferRef.current) return;
    const { blob, mime: mimeType, duration } = saved;
    if (!enabledRef.current) { setPhase("error"); setError("The session is closed. Download your recording below."); return; }
    const controller = new AbortController();
    transferRef.current = controller;
    setPhase("uploading");
    setProgress(null);
    setError("");
    let recordingId = "";
    try {
      const opened = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType, sizeBytes: blob.size, durationSeconds: duration }),
        signal: controller.signal,
      });
      const opening = await opened.json() as { recording?: CinemaRecordingView; partBytes?: number; parts?: number; error?: string };
      if (!opened.ok || !opening.recording || !opening.partBytes || !opening.parts) throw new Error(opening.error || "The recording could not be started.");
      recordingId = opening.recording.id;
      setProgress({ sent: 0, total: opening.parts });
      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (let index = 0; index < opening.parts; index += 1) {
        const offset = index * opening.partBytes;
        const chunk = blob.slice(offset, Math.min(blob.size, offset + opening.partBytes));
        const response = await putCinemaPart(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings/${encodeURIComponent(recordingId)}/part?n=${index + 1}`, chunk, controller.signal);
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
        signal: controller.signal,
      });
      const completion = await finished.json() as { recording?: CinemaRecordingView; error?: string };
      if (!finished.ok || !completion.recording) throw new Error(completion.error || "The recording could not be finished.");
      recovery.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
      setRecoveryUrl("");
      setPhase("ready");
      setProgress(null);
      onReady?.();
      await refresh();
    } catch (uploadError) {
      if (disposedRef.current) return;
      setError(uploadError instanceof Error ? uploadError.message : "The recording could not be uploaded.");
      setPhase("error");
      setProgress(null);
      if (recordingId) {
        await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/recordings?recordingId=${encodeURIComponent(recordingId)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      }
    } finally { transferRef.current = null; }
  }, [onReady, refresh, roomId]);

  const start = useCallback(() => {
    const activeStream = streamRef.current;
    if (!activeStream || recorderRef.current || !enabled || recovery.current || transferRef.current || !limits) return;
    const mimeType = chooseRecordingMimeType(activeStream.getVideoTracks().length > 0);
    if (!mimeType) { setError("This browser cannot record audio."); setPhase("error"); return; }
    try {
      const recordingStream = new MediaStream(activeStream.getTracks().map(track => track.clone()));
      captureRef.current = recordingStream;
      const recorder = new MediaRecorder(recordingStream, {
        mimeType,
        ...(activeStream.getVideoTracks().length > 0 ? { videoBitsPerSecond: 1_200_000 } : {}),
        audioBitsPerSecond: 96_000,
      });
      chunksRef.current = [];
      byteCount.current = 0;
      // Bound mobile memory and stop before the server's file-size ceiling.
      const maxBytes = Math.min(limits.maxBytes, 64 * 1024 * 1024);
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunksRef.current.push(event.data);
        byteCount.current += event.data.size;
        if (byteCount.current >= maxBytes * 0.9 && recorder.state !== "inactive") {
          stopReasonRef.current = "limit";
          recorder.stop();
        }
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        recordingStream.getTracks().forEach(track => track.stop());
        captureRef.current = null;
        sendRef.current({ type: "recording_state", active: false });
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (disposedRef.current) return;
        if (!blob.size) { setPhase("error"); setError("No audio was captured. Please try again."); return; }
        const paused = pausedTotalRef.current + (pausedAtRef.current ? Date.now() - pausedAtRef.current : 0);
        recovery.current = { blob, mime: mimeType.split(";")[0], duration: Math.max(0, Math.floor((Date.now() - startedAtRef.current - paused) / 1000)) };
        urlRef.current = URL.createObjectURL(blob);
        setRecoveryUrl(urlRef.current);
        void upload();
      };
      recorder.onerror = () => { setError("Recording stopped unexpectedly. Any captured audio will be kept for download."); if (recorder.state !== "inactive") recorder.stop(); };
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
      captureRef.current?.getTracks().forEach(track => track.stop());
      setError("This browser refused to start the recorder.");
      setPhase("error");
    }
  }, [enabled, upload, limits]);

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

  const discardRecovery = useCallback(() => {
    if (transferRef.current || recorderRef.current) return;
    recovery.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
    setRecoveryUrl(""); setPhase("idle"); setError("");
  }, []);

  const reset = useCallback(() => {
    if (recovery.current) return;
    setPhase("idle");
    setError("");
    setElapsedSeconds(0);
  }, []);

  return {
    recoveryUrl,

    retry: upload,
    discardRecovery,
    canStart: Boolean(limits) && !recoveryUrl,
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
