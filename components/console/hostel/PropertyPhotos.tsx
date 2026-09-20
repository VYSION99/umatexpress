"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, Check, ImagePlus, Loader2, Star, Trash2 } from "lucide-react";

type Photo = {
  id: string; propertyId: string; roomId: string; caption: string; sortOrder: number;
  status: string; contentType: string; bytes: number; reviewReason: string; createdAt: string;
};

type RoomOption = { id: string; label: string };

const MAX_BYTES = 6 * 1024 * 1024;
const STATUS_LABEL: Record<string, string> = { PENDING: "Waiting for review", APPROVED: "Live", REJECTED: "Rejected" };
const size = (bytes: number) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;

/**
 * The landlord's gallery for one property. Uploading is theirs; going live is
 * review's, which is why every row shows its status rather than pretending the
 * photo is already on the student page.
 */
export function PropertyPhotos({ propertyId, propertyName, rooms, onNotice }: {
  propertyId: string;
  propertyName: string;
  rooms: RoomOption[];
  onNotice: (message: string) => void;
}) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [caption, setCaption] = useState("");
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<{ id: string; caption: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/console/hostel/photos?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { photos?: Photo[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The photos could not be loaded.");
      setPhotos(data.photos || []);
    } catch (loadError) {
      setPhotos([]);
      setError(loadError instanceof Error ? loadError.message : "The photos could not be loaded.");
    }
  }, [propertyId]);

  useEffect(() => {
    queueMicrotask(() => {
      setError("");
      setCaption("");
      setRoomId("");
      void load();
    });
  }, [load]);

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await task();
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : "That did not work.");
    } finally {
      setBusy("");
    }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    await run("upload", async () => {
      const form = new FormData();
      form.set("propertyId", propertyId);
      form.set("roomId", roomId);
      form.set("caption", caption);
      form.set("file", file);
      const response = await fetch("/api/console/hostel/photos", { method: "POST", credentials: "same-origin", body: form });
      const data = await response.json() as { photo?: Photo; error?: string };
      if (!response.ok) throw new Error(data.error || "That photo could not be uploaded.");
      setCaption("");
      setRoomId("");
      if (fileInput.current) fileInput.current.value = "";
      onNotice(`${propertyName}: photo uploaded and sent for review.`);
      await load();
    });
  }

  const approved = (photos || []).filter((photo) => photo.status === "APPROVED").length;

  return <section className="console-panel">
    <h2><Camera size={18} aria-hidden />Photos
      <span className={`console-badge console-badge-${approved ? "approved" : "draft"}`}>{approved} live</span>
    </h2>
    <p className="console-note">
      Photos are what a student sees before your price. Approved photos appear on the map card and the listing page; a
      reviewer sees every upload, so nothing goes public on its own. {photos ? `${photos.length} of 12 used.` : ""}
    </p>
    {error && <div className="console-alert" role="alert">{error}</div>}

    <form className="console-form" onSubmit={upload}>
      <label>Photo
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" required />
      </label>
      <label>Room (optional)
        <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
          <option value="">The property as a whole</option>
          {rooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}
        </select>
      </label>
      <label>Caption (optional)
        <input type="text" value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={160} placeholder="Water tank and yard" />
      </label>
      <button type="submit" disabled={busy === "upload"}>
        {busy === "upload" ? <Loader2 size={15} className="console-spin" aria-hidden /> : <ImagePlus size={15} aria-hidden />}
        Upload photo
      </button>
    </form>
    <p className="console-note">JPEG, PNG or WebP, up to {Math.round(MAX_BYTES / 1024 / 1024)} MB each.</p>

    {!photos
      ? <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading photos…</p>
      : photos.length === 0
        ? <p className="console-empty">No photos yet. A listing with a photo gets picked; a listing without one gets scrolled past.</p>
        : <ul className="console-gallery">
          {photos.map((photo) => <li key={photo.id} className={`console-photo is-${photo.status.toLowerCase()}`}>
            <img src={`/api/console/hostel/photos/${photo.id}`} alt={photo.caption || `${propertyName} photo`} loading="lazy" />
            <div className="console-photo-body">
              <span className={`console-badge console-badge-${photo.status === "APPROVED" ? "approved" : photo.status === "REJECTED" ? "rejected" : "pending"}`}>
                {STATUS_LABEL[photo.status] || photo.status}
              </span>
              {photo.reviewReason && <small className="console-reason">{photo.reviewReason}</small>}
              {editing?.id === photo.id
                ? <div className="console-photo-edit">
                  <input
                    type="text"
                    aria-label="Caption"
                    value={editing.caption}
                    maxLength={160}
                    onChange={(event) => setEditing({ id: photo.id, caption: event.target.value })}
                  />
                  <button type="button" disabled={busy === photo.id} onClick={() => void run(photo.id, async () => {
                    const response = await fetch("/api/console/hostel/photos", {
                      method: "PATCH",
                      credentials: "same-origin",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ photoId: photo.id, caption: editing.caption }),
                    });
                    const data = await response.json() as { error?: string };
                    if (!response.ok) throw new Error(data.error || "That caption could not be saved.");
                    setEditing(null);
                    await load();
                  })}><Check size={14} aria-hidden />Save</button>
                  <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                </div>
                : <span className="console-photo-caption">{photo.caption || "No caption"}</span>}
              <small>{size(photo.bytes)}</small>
            </div>
            <div className="console-photo-actions">
              <button type="button" onClick={() => setEditing({ id: photo.id, caption: photo.caption })}>Caption</button>
              <button type="button" disabled={busy === `cover:${photo.id}` || photo.sortOrder === Math.min(...photos.map((entry) => entry.sortOrder))} onClick={() => void run(`cover:${photo.id}`, async () => {
                const response = await fetch("/api/console/hostel/photos", {
                  method: "PATCH",
                  credentials: "same-origin",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ photoId: photo.id, cover: true }),
                });
                const data = await response.json() as { error?: string };
                if (!response.ok) throw new Error(data.error || "That cover could not be set.");
                onNotice("Cover photo changed.");
                await load();
              })}><Star size={14} aria-hidden />Make cover</button>
              <button type="button" disabled={busy === `delete:${photo.id}`} onClick={() => void run(`delete:${photo.id}`, async () => {
                const response = await fetch(`/api/console/hostel/photos?photoId=${encodeURIComponent(photo.id)}`, { method: "DELETE", credentials: "same-origin" });
                const data = await response.json() as { error?: string };
                if (!response.ok) throw new Error(data.error || "That photo could not be removed.");
                onNotice("Photo removed.");
                await load();
              })}><Trash2 size={14} aria-hidden />Remove</button>
            </div>
          </li>)}
        </ul>}
  </section>;
}
