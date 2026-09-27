import type { PublicHostelPhoto } from "@/lib/hostel-engine/photos";
import type { PublicSpace } from "@/lib/hostel-engine/listings";

/** Room media inherits the same staff approval gate as the property gallery. */
export function HostelRoomMedia({ photos, spaces }: { photos: PublicHostelPhoto[]; spaces: PublicSpace[] }) {
  const labels = new Map(spaces.filter(space => space.roomId).map(space => [space.roomId, space.roomLabel]));
  const roomMedia = photos.filter(photo => photo.roomId && labels.has(photo.roomId));
  if (!roomMedia.length) return null;
  return <section className="hostel-room-media" aria-label="Room photos and floor plans">
    <div className="hostel-results-head"><h2>See the rooms</h2><span>Images checked before publication</span></div>
    <div className="hostel-room-media-grid">{roomMedia.map(photo => <figure key={photo.id}>
      <img src={`/api/hostel/photos/${encodeURIComponent(photo.id)}?width=640`} width={640} height={420} loading="lazy" decoding="async" alt={`${labels.get(photo.roomId)} ${photo.mediaKind === "FLOOR_PLAN" ? "floor plan" : "photo"}${photo.caption ? `: ${photo.caption}` : ""}`} />
      <figcaption><strong>{labels.get(photo.roomId)}</strong><span>{photo.mediaKind === "FLOOR_PLAN" ? "Floor plan" : "Photo"}{photo.caption ? ` · ${photo.caption}` : ""}</span></figcaption>
    </figure>)}</div>
  </section>;
}
