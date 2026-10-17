"use client";

import { useEffect, useState } from "react";
import { Camera, X } from "@/components/ui/MaterialIcon";
import type { CinemaPresenceMember } from "@/lib/cinema-engine/protocol";
import { MediaStreamVideo } from "./CinemaMediaVideo";
import type { CinemaMedia } from "./useCinemaMedia";

export type CinemaCameraContext = {
  media: CinemaMedia;
  members: CinemaPresenceMember[];
  selfId: string;
};

type CameraFeed = { id: string; name: string; stream: MediaStream };

/** Camera-only, muted copies of the room's existing streams for fullscreen. */
export function CinemaFullscreenCameras({ cameras, canPin = false }: { cameras?: CinemaCameraContext; canPin?: boolean }) {
  const [more, setMore] = useState(false);
  const [pinnedId, setPinnedId] = useState("");

  useEffect(() => {
    if (!more) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMore(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [more]);

  if (!cameras) return null;
  const { media, members, selfId } = cameras;
  const liveVideo = (stream: MediaStream | null) => Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live"));
  const feeds: CameraFeed[] = [];
  if (media.cameraOn && liveVideo(media.localStream)) feeds.push({ id: selfId, name: "You", stream: media.localStream as MediaStream });
  for (const member of members) {
    if (member.studentId === selfId || !member.camera) continue;
    const peer = media.remote.find((entry) => entry.studentId === member.studentId);
    if (peer && liveVideo(peer.stream)) feeds.push({ id: member.studentId, name: member.displayName || "Member", stream: peer.stream });
  }
  if (!feeds.length) return null;
  const sorted = pinnedId ? [...feeds].sort((a, b) => Number(b.id === pinnedId) - Number(a.id === pinnedId)) : feeds;
  const visible = sorted.slice(0, 3);
  const overflow = sorted.slice(3);
  const tile = (feed: CameraFeed) => <div className="cinema-fullscreen-camera" key={feed.id}>
    <MediaStreamVideo stream={feed.stream} muted className="cinema-fullscreen-camera-video" />
    <span title={feed.name}>{feed.name}</span>
    {canPin && <button type="button" className="cinema-fullscreen-camera-pin" aria-pressed={pinnedId === feed.id} aria-label={`${pinnedId === feed.id ? "Unpin" : "Pin"} ${feed.name}'s camera`} onClick={() => setPinnedId(current => current === feed.id ? "" : feed.id)}>{pinnedId === feed.id ? "Pinned" : "Pin"}</button>}
  </div>;

  return <aside className="cinema-fullscreen-cameras" aria-label="Live cameras">
    {more && <button type="button" className="cinema-fullscreen-camera-scrim" aria-label="Close more cameras" onClick={() => setMore(false)} />}
    <div className="cinema-fullscreen-camera-rail">
      {visible.map(tile)}
      {overflow.length > 0 && <button type="button" className="cinema-fullscreen-camera-more" aria-expanded={more} onClick={() => setMore((current) => !current)}><Camera size={15} aria-hidden /> More +{overflow.length}</button>}
    </div>
    {more && overflow.length > 0 && <div className="cinema-fullscreen-camera-pop" role="dialog" aria-label="More live cameras">
      <header><strong>More live cameras</strong><button type="button" aria-label="Close more cameras" onClick={() => setMore(false)}><X size={16} aria-hidden /></button></header>
      <div>{overflow.map(tile)}</div>
    </div>}
  </aside>;
}
