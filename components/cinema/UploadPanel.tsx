"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";

type UploadLimits = { maxBytes: number; partBytes: number; maxParts: number; types: string[] };
type UploadState = { id: string; status: string; filename: string; sizeBytes: number; mimeType: string; durationSeconds: number } | null;

/**
 * The host's one upload.
 *
 * The file is split into parts and each part is sent through the Worker, which
 * is what the transport decision in §17 chose: no S3 key exists, and the room's
 * rules are checked on every part rather than trusted from a URL. The ownership
 * question is asked before the first byte, because that answer is the platform's
 * record of who said the video could be shared.
 */
export function UploadPanel(input: { roomId: string; onUploaded: () => void }) {
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  const [upload, setUpload] = useState<UploadState>(null);
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
      return await response.json() as { upload?: UploadState; limits?: UploadLimits };
    } catch { return null; /* the panel simply stays as it was */ }
  }, [input.roomId]);

  const acceptState = useCallback((data: { upload?: UploadState; limits?: UploadLimits } | null) => {
    if (!data) return;
    setUpload(data.upload ?? null);
    setLimits(data.limits ?? null);
  }, []);

  useEffect(() => {
    let disposed = false;
    void requestState().then((data) => { if (!disposed) acceptState(data); });
    return () => { disposed = true; };
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
    if (file.size > limits.maxBytes) {
      setError(`That file is ${humanSize(file.size)}; this deployment accepts up to ${humanSize(limits.maxBytes)}.`);
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
      setUpload({ id: "pending", status: "UPLOADING", filename: file.name, sizeBytes: file.size, mimeType: file.type, durationSeconds: 0 });
      setTotal(opening.parts);
      setSent(0);

      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (let index = 0; index < opening.parts; index += 1) {
        const offset = index * opening.partBytes;
        const chunk = file.slice(offset, Math.min(file.size, offset + opening.partBytes));
        const response = await fetch(`/api/cinema/sessions/${input.roomId}/upload/part?n=${index + 1}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/octet-stream" },
          body: chunk,
          signal: controller.signal,
        });
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
      setError(aborted ? "Upload cancelled. Nothing of it was kept." : uploadError instanceof Error ? uploadError.message : "The upload failed.");
      // A cancelled upload is given up on the server too, so the room is clean.
      if (aborted) await fetch(`/api/cinema/sessions/${input.roomId}/upload`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      acceptState(await requestState());
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  if (upload?.status === "READY") {
    return <section className="cinema-card">
      <h2>Uploaded video</h2>
      <p className="cinema-note">
        This room plays <strong>{upload.filename || "an uploaded video"}</strong>{upload.sizeBytes ? ` (${humanSize(upload.sizeBytes)})` : ""}.
        It stays in the private bucket until the room is deleted, then it is removed automatically.
      </p>
    </section>;
  }

  return <section className="cinema-card">
    <h2>Play a file</h2>
    <p className="cinema-note">
      One video per room, MP4, MOV or WebM, up to {limits ? humanSize(limits.maxBytes) : "2 GB"}. It is stored privately and
      deleted when the room is; members watch it here and nowhere else.
    </p>
    <input
      className="cinema-upload-file"
      type="file"
      accept={limits?.types.join(",") || "video/mp4,video/quicktime,video/webm"}
      disabled={busy}
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
      <button type="button" disabled={busy || !file || !owned} onClick={() => void start()}>
        <Upload size={14} aria-hidden /> {busy ? "Uploading…" : "Upload the video"}
      </button>
      {busy && <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>Cancel</button>}
    </div>
    {error && <p className="cinema-error">{error}</p>}
  </section>;
}
