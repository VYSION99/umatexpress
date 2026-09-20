import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaRoom } from "@/components/cinema/CinemaRoom";
import { readRoom, type CinemaRoom as Room } from "@/lib/cinema-engine/rooms";

export const metadata: Metadata = {
  title: "Cinema room | UMaTeXPRESS",
  description: "A shared Cinema room for UMaT students.",
};

/**
 * One room, server-rendered so the shared link is useful before any script runs:
 * the title, the host and the state are in the first response. A room that has
 * expired or never existed is a 404, which is the same answer the API gives and
 * the reason an id cannot be probed for existence.
 */
export default async function CinemaRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let room: Room | null = null;
  try {
    room = await readRoom({ id });
  } catch {
    room = null;
  }
  if (!room) notFound();

  const stateCopy = room.status === "ENDED"
    ? "This room has ended"
    : room.status === "LIVE" ? "Live now" : "Waiting for the host to open it";

  return <CampusShell
    area="CINEMA"
    title={room.title}
    subtitle={`${stateCopy} · hosted by ${room.hostName}`}
  >
    <CinemaRoom initialRoom={room} />
  </CampusShell>;
}
