import type { Metadata } from "next";
import { CampusShell } from "@/components/campusRide/shared/CampusShell";
import { CinemaEvents } from "@/components/cinema/CinemaEvents";
import { CinemaSectionNav } from "@/components/cinema/CinemaSectionNav";

export const metadata: Metadata = { title: "Cinema events | UMaTeXPRESS", description: "Discover live tutorials, screenings, talks and student community events at UMaT." };
export default function CinemaEventsPage() { return <CampusShell area="CINEMA" title="Cinema" subtitle="Campus events, replays and smaller watch rooms in one place."><CinemaSectionNav current="events" /><CinemaEvents /></CampusShell>; }
