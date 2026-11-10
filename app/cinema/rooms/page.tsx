import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaLobby } from "@/components/cinema/CinemaLobby";
import { CinemaSectionNav } from "@/components/cinema/CinemaSectionNav";

export const metadata: Metadata = { title: "Your Cinema rooms | UMaTeXPRESS", description: "Open smaller link-based or invite-only watch rooms." };

export default function CinemaRoomsPage() {
  return <CampusShell area="CINEMA" title="Cinema" subtitle="Campus events, replays and smaller watch rooms in one place."><CinemaSectionNav current="rooms" /><CinemaLobby /></CampusShell>;
}
