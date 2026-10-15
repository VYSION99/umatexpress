import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaLobby } from "@/components/cinema/CinemaLobby";

export const metadata: Metadata = { title: "Your Cinema rooms | UMaTeXPRESS", description: "Create and manage private or shared Cinema rooms." };

export default function CinemaRoomsPage() {
  return <CampusShell area="CINEMA" title="Your rooms" subtitle="Create a smaller video room, invite your group, and watch or study together."><CinemaLobby /></CampusShell>;
}
