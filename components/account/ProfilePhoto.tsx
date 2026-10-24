"use client";

import { useEffect, useRef, useState } from "react";
import type { ProfileScope } from "@/lib/account-profile-photo";
import "./profile-photo.css";

const UPDATED = "umx:profile-photo-updated";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join("") || "U";
}

export function ProfileAvatar({ scope, name, className = "" }: { scope: ProfileScope; name: string; className?: string }) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<ProfileScope>).detail !== scope) return;
      setLoaded(false);
      setRevision(value => value + 1);
    };
    window.addEventListener(UPDATED, changed);
    return () => window.removeEventListener(UPDATED, changed);
  }, [scope]);
  return <span className={`profile-avatar ${className}`} aria-label={`Profile photo for ${name}`}>
    <span aria-hidden="true">{initials(name)}</span>
    <img src={`/api/profile/photo?scope=${scope}&v=${revision}`} alt="" aria-hidden="true" onLoad={() => setLoaded(true)} onError={() => setLoaded(false)} style={{ opacity: loaded ? 1 : 0 }} />
  </span>;
}

export function ProfilePhotoEditor({ scope, name }: { scope: ProfileScope; name: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const image = useRef<HTMLImageElement>(null);
  const previewUrl = useRef("");

  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);

  function clearPreview() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    setPreview(""); setFile(null);
  }

  async function save() {
    if (!file) return;
    if (!image.current?.naturalWidth) {
      setError("The photo is still loading. Try again in a moment.");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const source = image.current;
      const side = Math.min(source.naturalWidth, source.naturalHeight);
      const left = (source.naturalWidth - side) * x / 100;
      const top = (source.naturalHeight - side) * y / 100;
      const canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 512;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not crop the photo.");
      context.drawImage(source, left, top, side, side, 0, 0, 512, 512);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", .85));
      if (!blob) throw new Error("This browser could not prepare the photo.");
      const response = await fetch(`/api/profile/photo?scope=${scope}`, { method: "POST", credentials: "same-origin", headers: { "content-type": blob.type }, body: blob });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The photo could not be saved.");
      window.dispatchEvent(new CustomEvent(UPDATED, { detail: scope }));
      clearPreview(); setMessage("Profile photo updated.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The photo could not be saved."); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/profile/photo?scope=${scope}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("The photo could not be removed.");
      window.dispatchEvent(new CustomEvent(UPDATED, { detail: scope }));
      clearPreview(); setMessage("Profile photo removed.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The photo could not be removed."); }
    finally { setBusy(false); }
  }

  return <section className="profile-photo-editor" aria-label="Profile photo">
    <div className="profile-photo-editor-heading"><ProfileAvatar scope={scope} name={name} /><div><h3>Profile photo</h3><p>Only you can see this account photo. It is separate from verification documents.</p></div></div>
    <label className="profile-photo-file">Choose a photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => {
      const selected = event.target.files?.[0] || null;
      setError(""); setMessage("");
      if (selected && selected.size > 4 * 1024 * 1024) { setError("Choose a photo smaller than 4 MB."); clearPreview(); return; }
      clearPreview();
      if (selected) { const url = URL.createObjectURL(selected); previewUrl.current = url; setPreview(url); setFile(selected); }
      setX(50); setY(50);
    }} /></label>
    {preview && <div className="profile-photo-crop">
      <div className="profile-photo-preview"><img ref={image} src={preview} alt="Crop preview" style={{ objectPosition: `${x}% ${y}%` }} /></div>
      <div><label>Move left or right<input type="range" min="0" max="100" value={x} onChange={event => setX(Number(event.target.value))} /></label>
      <label>Move up or down<input type="range" min="0" max="100" value={y} onChange={event => setY(Number(event.target.value))} /></label></div>
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save photo"}</button>
    </div>}
    <button type="button" className="profile-photo-remove" disabled={busy} onClick={() => void remove()}>Remove current photo</button>
    {message && <p role="status" className="profile-photo-message">{message}</p>}
    {error && <p role="alert" className="profile-photo-message is-error">{error}</p>}
  </section>;
}
