"use client";

import { putCinemaPart } from "./transfer";

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadSimple } from "@/components/ui/MaterialIcon";

type UploadLimits = { maxBytes: number; partBytes: number; maxParts: number; types: string[] };
type UploadState = { id: string; status: string; filename: string; sizeBytes: number; mimeType: string; durationSeconds: number; playlistPosition: number } | null;
type Allowance = { plan: string; maxFiles: number; maxBytes: number; maxMinutes: number };

/**
 * The host's one upload, as a lobby step rather than a room control.
 *
 * The file is split into parts and each part is sent through the Worker, which
 * is what the transport decision in §17 chose: no S3 key exists, and the room's
 * rules are checked on every part rather than trusted from a URL. The ownership
 * question is asked before the first byte, because that answer is the platform's
 * record of who said the video could be shared. The panel is a body, not a
 * card: the lobby owns the heading and the room it is filling.
 */
export function UploadPanel(input: { roomId: string; onUploaded: () => void }) {
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  const [upload, setUpload] = useState<UploadState>(null);
  const [uploads, setUploads] = useState<NonNullable<UploadState>[]>([]);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [currentUploadId, setCurrentUploadId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [owned, setOwned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  /** The panel's state, as data; effects and handlers decide when to apply it. */
  const requestState = useCallback(async () => {
    try {
      const response = await fetch(`/api/cinema/sessions/${input.roomId}/upload`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return null;
      return await response.json() as { upload?: UploadState; uploads?: NonNullable<UploadState>[]; allowance?: Allowance; currentUploadId?: string; limits?: UploadLimits };
    } catch { return null; /* the panel simply stays as it was */ }
  }, [input.roomId]);

  const acceptState = useCallback((data: { upload?: UploadState; uploads?: NonNullable<UploadState>[]; allowance?: Allowance; currentUploadId?: string; limits?: UploadLimits } | null) => {
    if (!data) return;
    setUpload(data.upload ?? null);
    setLimits(data.limits ?? null);
    setUploads(data.uploads ?? []);
    setAllowance(data.allowance ?? null);
    setCurrentUploadId(data.currentUploadId ?? "");
  }, []);

  useEffect(() => {
    let disposed = false;
    void requestState().then((data) => { if (!disposed) acceptState(data); });
    return () => { disposed = true; abortRef.current?.abort(); };
  }, [requestState, acceptState]);

  const humanSize = (bytes: number) => bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

  const start = async () => {
    if (!file || !limits) return;
    setError("");
    if (!limits.types.includes(file.type)) {
      setError("That file type is not one this room plays. Use MP4, MOV or WebM.");
      return;
    }
    const remaining = allowance ? allowance.maxBytes - uploads.filter((entry) => entry.status === "READY").reduce((sum, entry) => sum + entry.sizeBytes, 0) : limits.maxBytes;
    const allowed = Math.min(limits.maxBytes, remaining);
    if (file.size > allowed) {
      setError(`That file is ${humanSize(file.size)}; this room has ${humanSize(Math.max(0, allowed))} available.`);
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const opened = await fetch(`/api/cinema/sessions/${input.roomId}/upload`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, sizeBytes: file.size, contentType: file.type, ownershipConfirmed: owned }),
        signal: controller.signal,
      });
      const opening = await opened.json() as { partBytes?: number; parts?: number; error?: string };
      if (!opened.ok || !opening.partBytes || !opening.parts) throw new Error(opening.error || "The upload could not be started.");
      setUpload({ id: "pending", status: "UPLOADING", filename: file.name, sizeBytes: file.size, mimeType: file.type, durationSeconds: 0, playlistPosition: 0 });
      setTotal(opening.parts);
      setSent(0);

      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (let index = 0; index < opening.parts; index += 1) {
        const offset = index * opening.partBytes;
        const chunk = file.slice(offset, Math.min(file.size, offset + opening.partBytes));
        const response = await putCinemaPart(`/api/cinema/sessions/${input.roomId}/upload/part?n=${index + 1}`, chunk, controller.signal);
        const data = await response.json() as { part?: { partNumber: number; etag: string }; error?: string };
        if (!response.ok || !data.part) throw new Error(data.error || `Part ${index + 1} did not arrive.`);
        parts.push(data.part);
        setSent(index + 1);
      }

      const finished = await fetch(`/api/cinema/sessions/${input.roomId}/upload/complete`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
        signal: controller.signal,
      });
      const completion = await finished.json() as { error?: string };
      if (!finished.ok) throw new Error(completion.error || "The upload could not be finished.");
      setFile(null);
      setOwned(false);
      setSent(0);
      setTotal(0);
      acceptState(await requestState());
      input.onUploaded();
    } catch (uploadError) {
      const aborted = controller.signal.aborted;
      setError(aborted ? "Upload cancelled. Temporary parts are queued for cleanup." : uploadError instanceof Error ? uploadError.message : "The upload failed.");
      // A cancelled upload is given up on the server too, so the room is clean.
      if (aborted) await fetch(`/api/cinema/sessions/${input.roomId}/upload`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      acceptState(await requestState());
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const readyUploads = uploads.filter((entry) => entry.status === "READY");
  const full = Boolean(allowance && readyUploads.length >= allowance.maxFiles);
  const currentIndex = readyUploads.findIndex((entry) => entry.id === currentUploadId);
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (busy || currentIndex < 0 || index <= currentIndex || target <= currentIndex || target >= readyUploads.length) return;
    setBusy(true); setError("");
    try {
      const order = readyUploads.slice(currentIndex + 1).map((entry) => entry.id);
      const from = index - currentIndex - 1;
      [order[from], order[from + direction]] = [order[from + direction], order[from]];
      const response = await fetch(`/api/cinema/sessions/${input.roomId}/playlist`, {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadIds: order }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The queue could not be reordered.");
      acceptState(await requestState());
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The queue could not be reordered."); }
    finally { setBusy(false); }
  };

  return <section className="cinema-upload-panel">
    <p className="cinema-note">
      {allowance?.plan.replaceAll("_", " ") || "Free"}: {readyUploads.length} of {allowance?.maxFiles || 1} files · {allowance ? humanSize(allowance.maxBytes) : "500 MB"} total · up to {allowance?.maxMinutes || 60} minutes.
      Videos play in this order, then the room stays open for discussion until you end it.
    </p>
    {upload?.status === "UPLOADING" && !busy && <p className="cinema-note">An upload is in progress. Cancel it before choosing another file.</p>}
    {readyUploads.length > 0 && <ol className="cinema-upload-queue">{readyUploads.map((entry, index) => <li key={entry.id}><strong>{entry.filename}</strong><span>{entry.id === currentUploadId ? "Playing" : humanSize(entry.sizeBytes)}</span>{index > currentIndex && currentIndex >= 0 && <span className="cinema-queue-actions"><button type="button" aria-label={`Move ${entry.filename} earlier`} disabled={busy || index <= currentIndex + 1} onClick={() => void move(index, -1)}>↑</button><button type="button" aria-label={`Move ${entry.filename} later`} disabled={busy || index >= readyUploads.length - 1} onClick={() => void move(index, 1)}>↓</button></span>}</li>)}</ol>}
    {full ? <p className="cinema-note">This room has reached its file allowance.</p> : <>
    <input
      className="cinema-upload-file"
      type="file"
      accept={limits?.types.join(",") || "video/mp4,video/quicktime,video/webm"}
      disabled={busy || full}
      aria-label="Choose a video file"
      onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }}
    />
    <label className="cinema-upload-consent">
      <input type="checkbox" checked={owned} disabled={busy} onChange={(event) => setOwned(event.target.checked)} />
      I recorded this, or I have the right to share it with this room.
    </label>
    {busy && total > 0 && <div className="cinema-upload-progress">
      <div className="cinema-upload-bar" style={{ width: `${Math.round((sent / total) * 100)}%` }} />
      <span>{Math.round((sent / total) * 100)}% — part {sent} of {total}</span>
    </div>}
    <div className="cinema-controls cinema-sub">
      <button type="button" disabled={busy || full || !file || !owned} onClick={() => void start()}>
        <UploadSimple size={14} aria-hidden /> {busy ? "Uploading…" : "Upload the video"}
      </button>
      {busy && <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>Cancel</button>}
    </div>
    </>}
    {error && <p className="cinema-error">{error}</p>}
  </section>;
}
