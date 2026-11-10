import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaEvents } from "@/components/cinema/CinemaEvents";
import { CinemaSectionNav } from "@/components/cinema/CinemaSectionNav";

export const metadata: Metadata = {
  title: "Cinema | UMaTeXPRESS",
  description: "Watch campus video events, live debates, and panel discussions. Join the audience, ask questions, vote, or take the speaking stage.",
};

export default function CinemaPage() {
  return <CampusShell
    area="CINEMA"
    title="Cinema"
    subtitle="Campus events, replays and smaller watch rooms in one place."
  >
    <CinemaSectionNav current="events" />
    <CinemaEvents />
  </CampusShell>;
}
