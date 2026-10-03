"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, Check, CircleNotch, ImageSquare, Star, Trash } from "@phosphor-icons/react";

type Photo = {
  id: string; propertyId: string; roomId: string; scopeType: "PROPERTY" | "BUILDING_AREA" | "ROOM_RANGE" | "ROOM"; scopeLabel: string; roomStartId: string; roomEndId: string; mediaKind: "PHOTO" | "FLOOR_PLAN"; caption: string; sortOrder: number;
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
  const [scopeType, setScopeType] = useState<"PROPERTY" | "BUILDING_AREA" | "ROOM_RANGE" | "ROOM">("PROPERTY");
  const [buildingArea, setBuildingArea] = useState("Building front");
  const [otherArea, setOtherArea] = useState("");
  const [roomStartId, setRoomStartId] = useState("");
  const [roomEndId, setRoomEndId] = useState("");
  const [mediaKind, setMediaKind] = useState<"PHOTO" | "FLOOR_PLAN">("PHOTO");
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
      setScopeType("PROPERTY");
      setRoomStartId("");
      setRoomEndId("");
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
      form.set("roomId", scopeType === "ROOM" ? roomId : "");
      form.set("scopeType", scopeType);
      form.set("scopeLabel", scopeType === "BUILDING_AREA" ? (buildingArea === "Other building area" ? otherArea : buildingArea) : "");
      form.set("roomStartId", scopeType === "ROOM_RANGE" ? roomStartId : "");
      form.set("roomEndId", scopeType === "ROOM_RANGE" ? roomEndId : "");
      form.set("mediaKind", mediaKind);
      form.set("caption", caption);
      form.set("file", file);
      const response = await fetch("/api/console/hostel/photos", { method: "POST", credentials: "same-origin", body: form });
      const data = await response.json() as { photo?: Photo; error?: string };
      if (!response.ok) throw new Error(data.error || "That photo could not be uploaded.");
      setCaption("");
      setRoomId("");
      setScopeType("PROPERTY");
      setRoomStartId("");
      setRoomEndId("");
      setMediaKind("PHOTO");
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
      <label>Media type
        <select value={mediaKind} onChange={(event) => {
          const next = event.target.value as "PHOTO" | "FLOOR_PLAN";
          setMediaKind(next);
          if (next === "FLOOR_PLAN") setScopeType("ROOM");
          else if (scopeType === "ROOM" && !roomId) setScopeType("PROPERTY");
        }}><option value="PHOTO">Photo</option><option value="FLOOR_PLAN" disabled={rooms.length === 0}>Room floor plan</option></select>
      </label>
      {rooms.length === 0 && <p className="console-note console-field-wide">Start with whole-building or building-area photos. Room photos and floor plans open after rooms are added in the approved workspace.</p>}
      {mediaKind === "PHOTO" && <label>What does this photo show?
        <select value={scopeType} onChange={(event) => { setScopeType(event.target.value as typeof scopeType); setRoomId(""); }}>
          <option value="PROPERTY">Whole property / building</option>
          <option value="BUILDING_AREA">A building area (front, back, shared area…)</option>
          <option value="ROOM_RANGE" disabled={rooms.length === 0}>A range of rooms</option>
          <option value="ROOM" disabled={rooms.length === 0}>One specific room</option>
        </select>
      </label>}
      {scopeType === "BUILDING_AREA" && <label>Building area
        <select value={buildingArea} onChange={(event) => setBuildingArea(event.target.value)}><option>Building front</option><option>Building back</option><option>Building side</option><option>Shared/common area</option><option>Other building area</option></select>
      </label>}
      {scopeType === "BUILDING_AREA" && buildingArea === "Other building area" && <label>Describe the area
        <input required maxLength={60} value={otherArea} onChange={(event) => setOtherArea(event.target.value)} placeholder="e.g. Laundry area" />
      </label>}
      {scopeType === "ROOM_RANGE" && <>
        <label>First room shown<select required value={roomStartId} onChange={(event) => setRoomStartId(event.target.value)}><option value="">Choose first room</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}</select></label>
        <label>Last room shown<select required value={roomEndId} onChange={(event) => setRoomEndId(event.target.value)}><option value="">Choose last room</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}</select></label>
        <p className="console-note console-field-wide">Use the first and last room labels covered by this photo. The range will be shown to students and reviewers.</p>
      </>}
      {(scopeType === "ROOM" || mediaKind === "FLOOR_PLAN") && <label>Room {mediaKind === "FLOOR_PLAN" ? "(required)" : ""}
        <select value={roomId} required onChange={(event) => setRoomId(event.target.value)}>
          <option value="">Choose a room</option>
          {rooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}
        </select>
      </label>}
      <label>Caption (optional)
        <input type="text" value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={160} placeholder="Water tank and yard" />
      </label>
      <button type="submit" disabled={busy === "upload"}>
        {busy === "upload" ? <CircleNotch size={15} className="console-spin" aria-hidden /> : <ImageSquare size={15} aria-hidden />}
        Upload photo
      </button>
    </form>
    <p className="console-note">JPEG, PNG or WebP, up to {Math.round(MAX_BYTES / 1024 / 1024)} MB each.</p>

    {!photos
      ? <p className="console-empty"><CircleNotch size={15} className="console-spin" aria-hidden /> Loading photos…</p>
      : photos.length === 0
        ? <p className="console-empty">No photos yet. A listing with a photo gets picked; a listing without one gets scrolled past.</p>
        : <ul className="console-gallery">
          {photos.map((photo) => <li key={photo.id} className={`console-photo is-${photo.status.toLowerCase()}`}>
            <img src={`/api/console/hostel/photos/${photo.id}`} alt={photo.caption || `${propertyName} photo`} loading="lazy" />
            <div className="console-photo-body">
              <span className={`console-badge console-badge-${photo.status === "APPROVED" ? "approved" : photo.status === "REJECTED" ? "rejected" : "pending"}`}>
                {STATUS_LABEL[photo.status] || photo.status} · {photo.mediaKind === "FLOOR_PLAN" ? `${photo.scopeLabel || "Room"} · Floor plan` : photo.scopeLabel || "Photo"}
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
              })}><Trash size={14} aria-hidden />Remove</button>
            </div>
          </li>)}
        </ul>}
  </section>;
}
