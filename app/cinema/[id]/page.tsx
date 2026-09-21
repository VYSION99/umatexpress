import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaRoom } from "@/components/cinema/CinemaRoom";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom, type CinemaRoom as Room } from "@/lib/cinema-engine/rooms";
import { studentAccountFromRequest } from "@/lib/student-auth";

export const metadata: Metadata = {
  title: "Cinema room | UMaTeXPRESS",
  description: "A shared Cinema room for UMaT students.",
};

/** The session cookie as a request the account helper already understands. */
async function signedInStudentId() {
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return undefined;
    const student = await studentAccountFromRequest(new Request("https://umatexpress.local/cinema", { headers: { cookie } }));
    return student?.id;
  } catch {
    return undefined;
  }
}

/**
 * One room, server-rendered so the shared link is useful before any script runs:
 * the title, the host and the state are in the first response. A room that has
 * expired or never existed is a 404, which is the same answer the API gives and
 * the reason an id cannot be probed for existence.
 */
export default async function CinemaRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let room: Room | null = null;
  let restricted = false;
  try {
    room = await readRoom({ id });
  } catch (error) {
    // A private room is a 403 from the engine rather than a 404, so the page
    // can tell a student with the link what is actually happening.
    restricted = error instanceof CampusEngineError && error.code === "FORBIDDEN";
    room = null;
  }
  // The anonymous read cannot tell the host from a stranger, so a refused room
  // gets one more look with the signed-in account before the door is shown.
  if (restricted) {
    const studentId = await signedInStudentId();
    if (studentId) {
      try {
        room = await readRoom({ id, studentId });
      } catch {
        room = null;
      }
    }
    restricted = !room;
  }
  if (restricted) return <CampusShell
    area="CINEMA"
    title="A private room"
    subtitle="Only invited students can open it"
  >
    <section className="cinema-card">
      <h2>This room is private</h2>
      <p className="cinema-note">
        The host keeps the guest list. If you were expecting to be on it, ask them to add your <strong>@st.umat.edu.gh</strong> address, then open the link again.
      </p>
      <div className="cinema-controls cinema-sub">
        <Link className="cinema-cta" href="/cinema">Back to the cinema lobby</Link>
      </div>
    </section>
  </CampusShell>;
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
