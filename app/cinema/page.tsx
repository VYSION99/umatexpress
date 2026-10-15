import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaEvents } from "@/components/cinema/CinemaEvents";

export const metadata: Metadata = {
  title: "Cinema | UMaTeXPRESS",
  description: "Watch campus video events, live debates, and panel discussions. Join the audience, ask questions, vote, or take the speaking stage.",
};

export default function CinemaPage() {
  return <CampusShell
    area="CINEMA"
    title="Live video & discussions"
    subtitle="Watch campus streams, debates and panels. Join the audience or take the speaking stage."
  >
    <CinemaEvents />
  </CampusShell>;
}
