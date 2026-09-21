"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Camera, CameraOff, ChevronRight, Circle, Mic, MicOff, X } from "lucide-react";
import type { CinemaPresenceMember } from "@/lib/cinema-engine/protocol";
import { MediaStreamVideo } from "./CinemaMediaVideo";
import type { CinemaMedia } from "./useCinemaMedia";

/** How many people the strip shows before the rest move behind the button. */
const INLINE_TILES = 5;

/**
 * The room's cameras, inline, under the video.
 *
 * Your own tile comes first, then the room's, and the strip stops at five: the
 * sixth person is not a tile that squeezes everybody else, it is a button at
 * the far right that opens the rest in a popup. On a phone the self-view used
 * to float over the header, where it hid the one thing the header says; the
 * tile belongs in the room's own flow, next to the faces it belongs with.
 *
 * This is also where audio-only peers get the element they play through.
 * The call's switches live in the rail on a phone; on a desktop, where there
 * is no rail, the room passes them in as `actions` so the strip carries them
 * beside the pictures they turn on.
 */
export function CinemaMediaStrip(input: {
  media: CinemaMedia;
  members: CinemaPresenceMember[];
  selfId: string;
  /** The call buttons, on surfaces that have no rail to put them in. */
  actions?: ReactNode;
}) {
  const { media, members, selfId, actions } = input;
  const [more, setMore] = useState(false);

  // Escape closes the popup; it is a list of faces, not a modal to get stuck in.
  useEffect(() => {
    if (!more) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMore(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [more]);

  const memberFor = (studentId: string) => members.find((member) => member.studentId === studentId);
  const others = members.filter((member) => member.studentId !== selfId);
  const inline = others.slice(0, INLINE_TILES - 1);
  const overflow = others.slice(INLINE_TILES - 1);
  const remoteWithCamera = media.remote.filter((peer) => {
    const member = memberFor(peer.studentId);
    return member?.camera === true || peer.stream.getVideoTracks().length > 0;
  });
  const remoteAudioOnly = media.remote.filter((peer) => !remoteWithCamera.includes(peer));

  /** One tile for one person: the picture, the name and the two switches. */
  const tile = (options: {
    key: string;
    name: string;
    stream: MediaStream | null;
    muted: boolean;
    mic: boolean;
    camera: boolean;
    recording?: boolean;
    level: number;
  }) => <article key={options.key} className={`cinema-strip-tile${options.level > 0 ? " is-speaking" : ""}`}>
    {options.stream
      ? <MediaStreamVideo stream={options.stream} muted={options.muted} className="cinema-strip-video" />
      : <div className="cinema-strip-placeholder">
        {!options.camera && <CameraOff size={13} aria-hidden />}
        <span>{options.name}</span>
      </div>}
    <footer>
      <strong title={options.name}>{options.name}</strong>
      <span className="cinema-media-flags">
        {options.mic ? <Mic size={11} aria-label="Microphone on" /> : <MicOff size={11} aria-label="Microphone off" />}
        {options.camera ? <Camera size={11} aria-label="Camera on" /> : <CameraOff size={11} aria-label="Camera off" />}
        {options.recording && <Circle size={10} className="cinema-recording-dot" aria-label="Recording" />}
      </span>
    </footer>
  </article>;

  const selfTile = tile({
    key: selfId || "self",
    name: "You",
    stream: media.cameraOn ? media.localStream : null,
    muted: true,
    mic: media.micOn,
    camera: media.cameraOn,
    level: media.localLevel,
  });

  const roomTile = (member: CinemaPresenceMember) => {
    const peer = media.remote.find((entry) => entry.studentId === member.studentId);
    return tile({
      key: member.studentId,
      name: member.displayName || "Member",
      stream: member.camera && peer ? peer.stream : null,
      muted: false,
      mic: member.mic,
      camera: member.camera,
      recording: member.recording,
      level: media.levels[member.studentId] ?? 0,
    });
  };

  return <section className="cinema-strip" aria-label="Cameras">
    <div className="cinema-strip-rail">
      {selfTile}
      {inline.map(roomTile)}
    </div>
    {overflow.length > 0 && <button
      type="button"
      className={`cinema-strip-more${more ? " is-open" : ""}`}
      aria-expanded={more}
      aria-label={`Show ${overflow.length} more ${overflow.length === 1 ? "camera" : "cameras"}`}
      title={`${overflow.length} more here`}
      onClick={() => setMore((current) => !current)}
    >
      <span>+{overflow.length}</span>
      <ChevronRight size={14} aria-hidden />
    </button>}
    {actions}

    {more && <>
      <button type="button" className="cinema-strip-scrim" aria-label="Close the camera list" onClick={() => setMore(false)} />
      <div className="cinema-strip-pop" role="dialog" aria-label="Everyone else in the room">
        <div className="cinema-strip-pop-head">
          <h3>{overflow.length} more in the room</h3>
          <button type="button" aria-label="Close the camera list" onClick={() => setMore(false)}><X size={14} aria-hidden /></button>
        </div>
        <div className="cinema-strip-rail is-pop">{overflow.map(roomTile)}</div>
      </div>
    </>}

    {/* Audio-only peers still need an element to play through. */}
    <div className="cinema-media-audio" aria-hidden>
      {remoteAudioOnly.map((peer) => <MediaStreamVideo key={peer.studentId} stream={peer.stream} />)}
    </div>
  </section>;
}
