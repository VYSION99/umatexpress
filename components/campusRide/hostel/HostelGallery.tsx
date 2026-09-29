"use client";

import { useState } from "react";
import type { PublicHostelPhoto } from "@/lib/hostel-engine/photos";

export function HostelGallery({ photos, name }: { photos: PublicHostelPhoto[]; name: string }) {
  const [selected, setSelected] = useState(0);
  const photo = photos[selected] || photos[0];
  if (!photo) return <div className="hostel-photo-placeholder hostel-gallery-placeholder">Photos of {name} are coming soon.</div>;
  return <section className="hostel-gallery" aria-label={`${name} photos`}>
    <img className="hostel-gallery-main" src={`/api/hostel/photos/${photo.id}?width=960`} srcSet={[640, 960, 1440].map(width => `/api/hostel/photos/${photo.id}?width=${width} ${width}w`).join(", ")} sizes="(max-width: 980px) 90vw, 720px" width={960} height={540} alt={`${photo.scopeLabel || name}${photo.caption ? `: ${photo.caption}` : `, photo ${selected + 1}`}`} decoding="async" />
    <p className="hostel-gallery-caption" aria-live="polite">{selected + 1} / {photos.length} · {photo.scopeLabel || "Whole property"}{photo.caption ? ` · ${photo.caption}` : ""}</p>
    {photos.length > 1 && <ul className="hostel-gallery-strip">{photos.map((item, index) => <li key={item.id}>
      <button type="button" aria-label={`View ${item.scopeLabel || "property"} photo ${index + 1}${item.caption ? `: ${item.caption}` : ""}`} aria-pressed={index === selected} onClick={() => setSelected(index)}>
        <img src={`/api/hostel/photos/${item.id}?width=160`} width={92} height={70} alt="" loading="lazy" decoding="async" />
      </button>
    </li>)}</ul>}
  </section>;
}
