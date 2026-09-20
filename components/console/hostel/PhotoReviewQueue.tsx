"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Camera, Check, Loader2, X } from "lucide-react";

type Photo = {
  id: string; propertyId: string; landlordId: string; caption: string;
  status: string; contentType: string; bytes: number; createdAt: string;
};

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * The photo queue. A landlord's upload is invisible to students until it is
 * approved here, which is the only thing standing between the student map and
 * whatever a camera happened to point at.
 */
export function PhotoReviewQueue({ onNotice }: { onNotice: (message: string) => void }) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/console/hostel/photos/review", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json() as { photos?: Photo[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The photo queue could not be loaded.");
      setPhotos(data.photos || []);
    } catch (loadError) {
      setPhotos([]);
      setError(loadError instanceof Error ? loadError.message : "The photo queue could not be loaded.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  async function decide(photo: Photo, action: "APPROVE" | "REJECT") {
    setBusy(photo.id);
    setError("");
    try {
      const response = await fetch("/api/console/hostel/photos/review", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ photoId: photo.id, action, reason: reasons[photo.id] || "" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "That decision could not be saved.");
      onNotice(action === "APPROVE" ? "Photo approved and now visible to students." : "Photo rejected; the landlord sees your reason.");
      setReasons((current) => ({ ...current, [photo.id]: "" }));
      await load();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "That decision could not be saved.");
    } finally {
      setBusy("");
    }
  }

  return <section className="console-panel">
    <h2><Camera size={18} aria-hidden />Photos waiting
      {photos && photos.length > 0 && <span className="console-badge">{photos.length}</span>}
    </h2>
    {error && <div className="console-alert" role="alert">{error}</div>}
    {!photos
      ? <p className="console-empty"><Loader2 size={15} className="console-spin" aria-hidden /> Loading photos…</p>
      : photos.length === 0
        ? <p className="console-empty">No photo is waiting. A listing without a photo has nothing for a student to trust.</p>
        : <ul className="console-gallery">
          {photos.map((photo) => <li key={photo.id} className="console-photo is-pending">
            <img src={`/api/console/hostel/photos/${photo.id}`} alt={photo.caption || "Property photo awaiting review"} loading="lazy" />
            <div className="console-photo-body">
              <span className="console-badge console-badge-pending">WAITING</span>
              <span className="console-photo-caption">{photo.caption || "No caption"}</span>
              <small>{when(photo.createdAt)} · {(Number(photo.bytes || 0) / 1024 / 1024).toFixed(1)} MB</small>
              <div className="console-photo-edit">
                <input
                  type="text"
                  aria-label="Reason (needed to reject)"
                  placeholder="Reason (needed to reject)"
                  maxLength={200}
                  value={reasons[photo.id] || ""}
                  onChange={(event) => setReasons({ ...reasons, [photo.id]: event.target.value })}
                />
              </div>
            </div>
            <div className="console-photo-actions">
              <button type="button" disabled={busy === photo.id} onClick={() => void decide(photo, "APPROVE")}><Check size={14} aria-hidden />Approve</button>
              <button type="button" disabled={busy === photo.id} onClick={() => void decide(photo, "REJECT")}><X size={14} aria-hidden />Reject</button>
            </div>
          </li>)}
        </ul>}
    <p className="console-note">
      <BadgeCheck size={13} aria-hidden /> Approving a photo publishes it on the property&apos;s map card and listing page. Rejecting keeps it private and shows the landlord why.
    </p>
  </section>;
}
