import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaLobby } from "@/components/cinema/CinemaLobby";

export const metadata: Metadata = { title: "Your Cinema rooms | UMaTeXPRESS", description: "Open smaller link-based or invite-only watch rooms." };

export default function CinemaRoomsPage() {
  return <CampusShell area="CINEMA" title="Watch rooms" subtitle="Smaller spaces opened by a host and joined by link or invitation. No event RSVP is needed."><CinemaLobby /></CampusShell>;
}
